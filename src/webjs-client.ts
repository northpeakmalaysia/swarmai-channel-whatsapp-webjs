import { EventEmitter } from 'node:events';
import { logger as sharedLogger } from '@swarmai/shared';
import type {
  WhatsAppWebJsConfig,
  WhatsAppWebJsConnectionStatus,
  WebJsMessage,
} from './types.js';
import {
  ensureSessionDir,
  acquireSessionLock,
  sanitiseSessionId,
  type SessionLockHandle,
} from './session-store.js';
import { probeChromiumPath, SESSION_0_SAFE_CHROME_ARGS } from './chromium-probe.js';

/**
 * `WebJsClient` — thin event-emitter wrapper around whatsapp-web.js'
 * `Client` class.
 *
 * Why a wrapper:
 *   - whatsapp-web.js' Client carries a heavy puppeteer + WhatsApp Web
 *     surface that's awkward to test. We narrow to four signals (qr,
 *     ready, message, disconnected) plus `sendMessage`.
 *   - The CLI's pair flow uses the same wrapper to drive the QR loop
 *     without instantiating the full plugin.
 *
 * DI seam: `WebJsAdapter` is the structural interface the wrapper
 * builds against. Default impl lazy-loads whatsapp-web.js; tests pass
 * a fake adapter so unit tests don't need puppeteer.
 */

const SEND_TIMEOUT_TEXT_MS = 30_000;
const SEND_TIMEOUT_MEDIA_MS = 90_000;

function withSendTimeout<T>(p: Promise<T>, timeoutMs: number, kind: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `whatsapp-webjs: send timed out after ${timeoutMs}ms (waiting for WhatsApp ACK on ${kind}). ` +
            'Common causes: Chrome process hung, stale session, network blocked.',
        ),
      );
    }, timeoutMs);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * Subset of whatsapp-web.js Client surface we consume. Structural —
 * lets the test harness inject a fake without pulling in puppeteer.
 */
export interface WebJsClientHandle {
  on(event: string, cb: (...args: unknown[]) => void): unknown;
  off?(event: string, cb: (...args: unknown[]) => void): unknown;
  removeAllListeners?(event?: string): unknown;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  logout?(): Promise<void>;
  sendMessage(
    chatId: string,
    content: unknown,
    options?: Record<string, unknown>,
  ): Promise<{ id?: { _serialized?: string } } | undefined>;
  getChatById?(chatId: string): Promise<{
    sendStateTyping?(): Promise<void>;
    clearState?(): Promise<void>;
    sendSeen?(): Promise<void>;
  }>;
  info?: { wid?: { user?: string; _serialized?: string } };
}

/**
 * Factory function the adapter exposes — equivalent to
 * `new Client({...})` from whatsapp-web.js.
 */
export interface WebJsAdapter {
  /** Build the Client with auth strategy + puppeteer config. */
  createClient(args: {
    clientId: string;
    dataPath: string;
    chromiumPath: string | null;
    headless: boolean;
    extraArgs: string[];
  }): WebJsClientHandle;
  /** Build a MessageMedia from a file on disk. */
  mediaFromFilePath(path: string): unknown;
  /** Build a MessageMedia from raw bytes + mime. */
  mediaFromBuffer(args: {
    mimetype: string;
    data: Buffer;
    filename?: string;
  }): unknown;
}

export interface WebJsClientOptions {
  config: WhatsAppWebJsConfig;
  /** Inject an adapter (tests). Default: lazy-load whatsapp-web.js. */
  adapter?: WebJsAdapter;
}

/**
 * Events emitted:
 *   - `qr` (qr: string)
 *   - `launching` ()
 *   - `authenticated` ()
 *   - `connected` ({ phoneNumber: string | null })
 *   - `reconnecting` ({ attempt: number; delayMs: number })
 *   - `disconnected` ({ reason: 'logged-out' | 'transient'; detail?: string })
 *   - `session-expired` ({ detail?: string })
 *   - `session-down` ({ attempts: number })
 *   - `message` (msg: WebJsMessage)
 *   - `error` (err: Error)
 */
export class WebJsClient extends EventEmitter {
  private readonly config: WhatsAppWebJsConfig;
  private readonly adapter: WebJsAdapter;
  private client: WebJsClientHandle | null = null;
  private status: WhatsAppWebJsConnectionStatus = 'idle';
  private consecutiveFailures = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopRequested = false;
  private sessionDir: string | null = null;
  private phoneNumber: string | null = null;
  private lockHandle: SessionLockHandle | null = null;

  constructor(opts: WebJsClientOptions) {
    super();
    this.config = opts.config;
    this.adapter = opts.adapter ?? defaultWebJsAdapter();
  }

  getStatus(): WhatsAppWebJsConnectionStatus {
    return this.status;
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  /** WID-formatted self id used by inbound normaliser for mention detection. */
  getOwnId(): string | null {
    const wid = this.client?.info?.wid?._serialized;
    return wid ?? null;
  }

  async start(): Promise<void> {
    if (this.client) return;
    this.stopRequested = false;

    const sid = sanitiseSessionId(this.config.sessionId);
    const sessionPaths = ensureSessionDir({
      sessionId: sid,
      ...(this.config.sessionDir ? { baseDir: this.config.sessionDir } : {}),
    });
    this.sessionDir = sessionPaths.sessionDir;

    // Acquire single-instance lock. Throws SessionLockedError if a live
    // peer holds the dir — caller surfaces to the operator.
    this.lockHandle = acquireSessionLock({
      sessionDir: this.sessionDir,
      heartbeatMs: this.config.lockHeartbeatMs,
      staleMs: this.config.lockStaleMs,
    });

    const chromiumPath = this.config.chromiumExecutablePath ?? probeChromiumPath();
    if (!chromiumPath) {
      throw new Error(
        'whatsapp-webjs: no Chrome / Edge / Chromium executable found. ' +
          'Install Chrome from https://www.google.com/chrome/ or set SWARMAI_CHROMIUM_PATH ' +
          'to the executable path.',
      );
    }

    this.status = 'launching';
    this.emit('launching');

    this.client = this.adapter.createClient({
      clientId: sid,
      dataPath: this.sessionDir,
      chromiumPath,
      headless: this.config.headless,
      extraArgs: SESSION_0_SAFE_CHROME_ARGS,
    });

    this.wireClientEvents();

    try {
      await this.client.initialize();
    } catch (err) {
      sharedLogger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'whatsapp-webjs: initialize failed',
      );
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      this.scheduleReconnect(err instanceof Error ? err.message : String(err));
    }
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      try {
        await this.client.destroy();
      } catch (err) {
        sharedLogger.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'whatsapp-webjs: destroy() threw — ignoring during stop',
        );
      }
      this.client = null;
    }
    if (this.lockHandle) {
      this.lockHandle.release();
      this.lockHandle = null;
    }
    this.status = 'idle';
  }

  /**
   * Send a text-only message. Wraps `client.sendMessage(chatId, body)`
   * with a fail-fast timeout so the agent doesn't wait on a hung Chrome
   * process.
   */
  async sendText(chatId: string, body: string): Promise<string | undefined> {
    this.assertConnected('sendText');
    const start = Date.now();
    sharedLogger.debug({ chatId, bytes: body.length }, 'whatsapp-webjs: send.text start');
    try {
      const result = await withSendTimeout(
        this.client!.sendMessage(chatId, body),
        SEND_TIMEOUT_TEXT_MS,
        'text',
      );
      const id = result?.id?._serialized;
      sharedLogger.debug(
        { chatId, ms: Date.now() - start, id },
        'whatsapp-webjs: send.text ok',
      );
      return id;
    } catch (err) {
      sharedLogger.warn(
        { chatId, ms: Date.now() - start, err: err instanceof Error ? err.message : String(err) },
        'whatsapp-webjs: send.text failed',
      );
      throw err;
    }
  }

  /**
   * Send a media message — `content` is a MessageMedia instance built
   * by the adapter (`mediaFromFilePath` / `mediaFromBuffer`). `options`
   * carries `caption`, `sendAudioAsVoice`, `sendMediaAsDocument`, etc.
   */
  async sendMedia(
    chatId: string,
    media: unknown,
    options: Record<string, unknown>,
    diagnostics: { kind: string; bytes: number },
  ): Promise<string | undefined> {
    this.assertConnected('sendMedia');
    const start = Date.now();
    let heartbeat: NodeJS.Timeout | undefined;
    sharedLogger.debug(
      { chatId, ...diagnostics },
      'whatsapp-webjs: send.media start',
    );
    heartbeat = setInterval(() => {
      sharedLogger.debug(
        { chatId, ms: Date.now() - start, ...diagnostics },
        'whatsapp-webjs: send.media still waiting',
      );
    }, 10_000);
    if (heartbeat.unref) heartbeat.unref();

    try {
      const result = await withSendTimeout(
        this.client!.sendMessage(chatId, media, options),
        SEND_TIMEOUT_MEDIA_MS,
        diagnostics.kind,
      );
      const id = result?.id?._serialized;
      sharedLogger.debug(
        { chatId, ms: Date.now() - start, id, ...diagnostics },
        'whatsapp-webjs: send.media ok',
      );
      return id;
    } catch (err) {
      sharedLogger.warn(
        { chatId, ms: Date.now() - start, err: err instanceof Error ? err.message : String(err), ...diagnostics },
        'whatsapp-webjs: send.media failed',
      );
      throw err;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  /** Build a MessageMedia from a file path. */
  mediaFromFilePath(path: string): unknown {
    return this.adapter.mediaFromFilePath(path);
  }

  /** Build a MessageMedia from raw bytes. */
  mediaFromBuffer(args: { mimetype: string; data: Buffer; filename?: string }): unknown {
    return this.adapter.mediaFromBuffer(args);
  }

  /**
   * Show / clear the typing indicator on `chatId`. Best-effort — failures
   * are swallowed by the caller (typing is UX, not correctness).
   */
  async setTyping(chatId: string, on: boolean): Promise<void> {
    if (!this.client?.getChatById) return;
    if (this.status !== 'connected') return;
    try {
      const chat = await this.client.getChatById(chatId);
      if (on && chat.sendStateTyping) {
        await chat.sendStateTyping();
      } else if (!on && chat.clearState) {
        await chat.clearState();
      }
    } catch {
      /* typing failure is never fatal */
    }
  }

  /** Mark a message as read by sending a `seen` ack on its chat. */
  async markRead(chatId: string): Promise<void> {
    if (!this.client?.getChatById) return;
    if (this.status !== 'connected') return;
    try {
      const chat = await this.client.getChatById(chatId);
      if (chat.sendSeen) await chat.sendSeen();
    } catch (err) {
      sharedLogger.debug(
        { chatId, err: err instanceof Error ? err.message : String(err) },
        'whatsapp-webjs: markRead failed (non-fatal)',
      );
    }
  }

  /** Download media bytes for an inbound message. Returns null on failure. */
  async downloadMedia(msg: WebJsMessage): Promise<Uint8Array | null> {
    if (!msg.downloadMedia) return null;
    try {
      const result = await msg.downloadMedia();
      if (!result || !result.data) return null;
      return Uint8Array.from(Buffer.from(result.data, 'base64'));
    } catch (err) {
      sharedLogger.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'whatsapp-webjs: downloadMedia failed',
      );
      return null;
    }
  }

  // ---- internal --------------------------------------------------------------

  private assertConnected(op: string): void {
    if (!this.client) {
      throw new Error(`whatsapp-webjs: cannot ${op} — client not started`);
    }
    if (this.status !== 'connected') {
      throw new Error(
        `whatsapp-webjs: cannot ${op} — current status is ${this.status} (expected connected)`,
      );
    }
  }

  private wireClientEvents(): void {
    if (!this.client) return;
    const c = this.client;
    c.on('qr', (qr: unknown) => {
      this.status = 'qr';
      this.emit('qr', String(qr));
    });
    c.on('authenticated', () => {
      this.status = 'authenticated';
      this.emit('authenticated');
    });
    c.on('auth_failure', (msg: unknown) => {
      const detail = typeof msg === 'string' ? msg : String(msg);
      this.status = 'session-expired';
      this.emit('session-expired', { detail });
    });
    c.on('ready', () => {
      this.status = 'connected';
      this.consecutiveFailures = 0;
      const wid = c.info?.wid?.user ?? null;
      this.phoneNumber = wid;
      this.emit('connected', { phoneNumber: wid });
    });
    c.on('disconnected', (reason: unknown) => {
      const detail = typeof reason === 'string' ? reason : String(reason);
      this.status = 'reconnecting';
      const isLoggedOut = /logged?\s*out|conflict|forbidden/i.test(detail);
      this.emit('disconnected', {
        reason: isLoggedOut ? 'logged-out' : 'transient',
        detail,
      });
      if (isLoggedOut) {
        this.status = 'session-expired';
        this.emit('session-expired', { detail });
        return;
      }
      this.scheduleReconnect(detail);
    });
    c.on('message', (msg: unknown) => {
      const m = msg as WebJsMessage;
      this.emit('message', m);
    });
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopRequested) return;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures > this.config.reconnectMaxAttempts) {
      this.status = 'session-down';
      this.emit('session-down', { attempts: this.consecutiveFailures });
      sharedLogger.warn(
        { attempts: this.consecutiveFailures, reason },
        'whatsapp-webjs: giving up reconnecting',
      );
      return;
    }
    const base = this.config.reconnectBaseBackoffMs;
    const cap = this.config.reconnectMaxBackoffMs;
    const delayMs = Math.min(cap, base * Math.pow(2, this.consecutiveFailures - 1));
    this.emit('reconnecting', { attempt: this.consecutiveFailures, delayMs });
    sharedLogger.warn(
      { attempt: this.consecutiveFailures, delayMs, reason },
      'whatsapp-webjs: scheduling reconnect',
    );
    this.reconnectTimer = setTimeout(() => {
      void this.restart();
    }, delayMs);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  private async restart(): Promise<void> {
    if (this.stopRequested) return;
    try {
      if (this.client) {
        try {
          await this.client.destroy();
        } catch {
          /* swallow */
        }
        this.client = null;
      }
      // Don't release the lock — we still own the session dir.
      await this.start();
    } catch (err) {
      sharedLogger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'whatsapp-webjs: restart failed',
      );
      this.scheduleReconnect(err instanceof Error ? err.message : String(err));
    }
  }
}

/**
 * Default adapter — lazy-loads whatsapp-web.js. Kept separate so the
 * test harness can build a fake without paying the puppeteer import
 * cost. This function only runs the first time a `WebJsClient` is
 * instantiated in production.
 */
export function defaultWebJsAdapter(): WebJsAdapter {
  return {
    createClient(args) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const wwebjs = require('whatsapp-web.js') as {
        Client: new (opts: unknown) => WebJsClientHandle;
        LocalAuth: new (opts: { clientId: string; dataPath: string }) => unknown;
      };
      const { Client, LocalAuth } = wwebjs;
      return new Client({
        authStrategy: new LocalAuth({
          clientId: args.clientId,
          dataPath: args.dataPath,
        }),
        puppeteer: {
          executablePath: args.chromiumPath ?? undefined,
          headless: args.headless,
          args: args.extraArgs,
        },
      });
    },
    mediaFromFilePath(path) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const { MessageMedia } = require('whatsapp-web.js') as {
        MessageMedia: { fromFilePath(p: string): unknown };
      };
      return MessageMedia.fromFilePath(path);
    },
    mediaFromBuffer(args) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const { MessageMedia } = require('whatsapp-web.js') as {
        MessageMedia: new (mime: string, base64: string, filename?: string) => unknown;
      };
      return new (MessageMedia as unknown as {
        new (mime: string, base64: string, filename?: string): unknown;
      })(args.mimetype, args.data.toString('base64'), args.filename);
    },
  };
}
