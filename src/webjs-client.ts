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
/** Group/contact/profile control ops over puppeteer can be slow; 30s. */
const GROUP_OP_TIMEOUT_MS = 30_000;

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

/** Structural whatsapp-web.js GroupChat (the fields/methods we use). */
export interface WebJsGroupChatHandle {
  id?: { _serialized?: string };
  name?: string;
  subject?: string;
  description?: string;
  owner?: { _serialized?: string };
  isGroup?: boolean;
  participants?: Array<{ id?: { _serialized?: string }; isAdmin?: boolean; isSuperAdmin?: boolean }>;
  groupMetadata?: { announce?: boolean; restrict?: boolean; creation?: number; size?: number };
  // typing / read (already used by setTyping/markRead)
  sendStateTyping?(): Promise<void>;
  clearState?(): Promise<void>;
  sendSeen?(): Promise<void>;
  // group management
  addParticipants?(ids: string[]): Promise<unknown>;
  removeParticipants?(ids: string[]): Promise<unknown>;
  promoteParticipants?(ids: string[]): Promise<unknown>;
  demoteParticipants?(ids: string[]): Promise<unknown>;
  setSubject?(subject: string): Promise<unknown>;
  setDescription?(description: string): Promise<unknown>;
  setMessagesAdminsOnly?(adminsOnly: boolean): Promise<unknown>;
  setInfoAdminsOnly?(adminsOnly: boolean): Promise<unknown>;
  leave?(): Promise<unknown>;
  getInviteCode?(): Promise<string>;
  revokeInvite?(): Promise<string>;
}

export interface WebJsContactHandle {
  block?(): Promise<unknown>;
  unblock?(): Promise<unknown>;
  getAbout?(): Promise<string | null>;
}

export interface WebJsMessageHandle {
  react?(emoji: string): Promise<void>;
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
  getChatById?(chatId: string): Promise<WebJsGroupChatHandle>;
  info?: { wid?: { user?: string; _serialized?: string } };
  // --- capability surface (whatsapp-web.js) ---
  getChats?(): Promise<WebJsGroupChatHandle[]>;
  createGroup?(
    name: string,
    participants: string[],
  ): Promise<{ gid?: { _serialized?: string } | string } | string>;
  acceptInvite?(inviteCode: string): Promise<string>;
  getInviteInfo?(inviteCode: string): Promise<WebJsGroupChatHandle>;
  getNumberId?(number: string): Promise<{ _serialized?: string } | null>;
  getProfilePicUrl?(contactId: string): Promise<string | undefined>;
  getContactById?(contactId: string): Promise<WebJsContactHandle>;
  setDisplayName?(name: string): Promise<boolean>;
  setStatus?(status: string): Promise<void>;
  getMessageById?(messageId: string): Promise<WebJsMessageHandle>;
}

/** Normalised group summary returned by `listGroups()`. */
export interface WhatsAppGroupSummary {
  jid: string;
  subject: string;
  participantCount: number;
  selfIsAdmin: boolean;
  announce: boolean;
}
export interface WhatsAppGroupInfo extends WhatsAppGroupSummary {
  owner?: string;
  description?: string;
  creation?: number;
  restrict: boolean;
  participants: Array<{ jid: string; admin: 'admin' | 'superadmin' | null }>;
}
export interface WhatsAppNumberCheck {
  input: string;
  jid?: string;
  exists: boolean;
}
export interface WhatsAppParticipantResult {
  jid: string;
  status: string;
}

/**
 * Adapter-agnostic WhatsApp capability contract. Structurally identical
 * to the Baileys plugin's `WhatsAppCapabilities` and the
 * `@swarmai/tools` `WhatsAppCapabilitiesLike` mirror — so the gateway's
 * tool resolver can hand either adapter's object straight through.
 */
export interface WhatsAppCapabilities {
  listGroups(): Promise<WhatsAppGroupSummary[]>;
  getGroupInfo(jid: string): Promise<WhatsAppGroupInfo>;
  createGroup(subject: string, participants: string[]): Promise<WhatsAppGroupInfo>;
  leaveGroup(jid: string): Promise<void>;
  addParticipants(jid: string, participants: string[]): Promise<WhatsAppParticipantResult[]>;
  removeParticipants(jid: string, participants: string[]): Promise<WhatsAppParticipantResult[]>;
  promoteParticipants(jid: string, participants: string[]): Promise<WhatsAppParticipantResult[]>;
  demoteParticipants(jid: string, participants: string[]): Promise<WhatsAppParticipantResult[]>;
  setGroupSubject(jid: string, subject: string): Promise<void>;
  setGroupDescription(jid: string, description: string): Promise<void>;
  setGroupSetting(
    jid: string,
    setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked',
  ): Promise<void>;
  getInviteCode(jid: string): Promise<string>;
  revokeInviteCode(jid: string): Promise<string>;
  joinGroup(inviteCodeOrLink: string): Promise<{ groupJid?: string }>;
  inviteInfo(inviteCodeOrLink: string): Promise<WhatsAppGroupInfo>;
  checkOnWhatsApp(numbers: string[]): Promise<WhatsAppNumberCheck[]>;
  getProfilePicture(jid: string): Promise<string | null>;
  blockContact(jid: string): Promise<void>;
  unblockContact(jid: string): Promise<void>;
  getStatus(jid: string): Promise<string | null>;
  setOwnName(name: string): Promise<void>;
  setOwnStatus(status: string): Promise<void>;
  sendReaction(
    jid: string,
    messageId: string,
    emoji: string,
    opts?: { fromMe?: boolean; participant?: string },
  ): Promise<void>;
  sendLocation(jid: string, latitude: number, longitude: number, name?: string): Promise<string | undefined>;
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
  /** Build a Location message body for `sendLocation`. */
  location?(args: { latitude: number; longitude: number; name?: string }): unknown;
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

  /**
   * Full WhatsApp capability surface (groups/contacts/profile/reactions/
   * location) backed by the live whatsapp-web.js Client. Mirrors the
   * Baileys plugin's `getCapabilities()` so the gateway's `whatsapp.*`
   * tools work identically across adapters. Every method asserts
   * connection + method presence, races a 30s timeout, and normalises
   * whatsapp-web.js' shapes into the stable result types.
   */
  getCapabilities(): WhatsAppCapabilities {
    const self = (): string | null => bareDigitsFromId(this.getOwnId());
    const client = (): WebJsClientHandle => {
      this.assertConnected('capability-op');
      return this.client!;
    };
    const need = <K extends keyof WebJsClientHandle>(c: WebJsClientHandle, m: K): WebJsClientHandle => {
      if (typeof c[m] !== 'function') {
        throw new Error(`whatsapp-webjs: ${String(m)} not supported by this whatsapp-web.js build`);
      }
      return c;
    };
    const group = async (jid: string): Promise<WebJsGroupChatHandle> => {
      const c = need(client(), 'getChatById');
      const chat = await withSendTimeout(c.getChatById!(jid), GROUP_OP_TIMEOUT_MS, 'get-chat');
      return chat;
    };
    const toInfo = (chat: WebJsGroupChatHandle): WhatsAppGroupInfo => normalizeGroupInfo(chat, self());
    const toSummary = (info: WhatsAppGroupInfo): WhatsAppGroupSummary => ({
      jid: info.jid,
      subject: info.subject,
      participantCount: info.participantCount,
      selfIsAdmin: info.selfIsAdmin,
      announce: info.announce,
    });

    return {
      listGroups: async () => {
        const c = need(client(), 'getChats');
        const chats = await withSendTimeout(c.getChats!(), GROUP_OP_TIMEOUT_MS, 'list-groups');
        return (chats ?? []).filter((ch) => ch.isGroup).map((ch) => toSummary(toInfo(ch)));
      },
      getGroupInfo: async (jid) => toInfo(await group(jid)),
      createGroup: async (subject, participants) => {
        const c = need(client(), 'createGroup');
        const res = await withSendTimeout(c.createGroup!(subject, participants), GROUP_OP_TIMEOUT_MS, 'create-group');
        const gid =
          typeof res === 'string'
            ? res
            : typeof res?.gid === 'string'
              ? res.gid
              : res?.gid?._serialized;
        if (gid) {
          try {
            return toInfo(await group(gid));
          } catch {
            /* fall through to minimal */
          }
        }
        return normalizeGroupInfo({ id: { _serialized: gid }, subject, participants: [] }, self());
      },
      leaveGroup: async (jid) => {
        const chat = await group(jid);
        if (typeof chat.leave !== 'function') throw new Error('whatsapp-webjs: leave not supported');
        await withSendTimeout(chat.leave(), GROUP_OP_TIMEOUT_MS, 'leave-group');
      },
      addParticipants: async (jid, participants) => {
        const chat = await group(jid);
        if (typeof chat.addParticipants !== 'function') throw new Error('whatsapp-webjs: addParticipants not supported');
        const raw = await withSendTimeout(chat.addParticipants(participants), GROUP_OP_TIMEOUT_MS, 'add-participants');
        return participantResults(raw, participants);
      },
      removeParticipants: async (jid, participants) => {
        const chat = await group(jid);
        if (typeof chat.removeParticipants !== 'function') throw new Error('whatsapp-webjs: removeParticipants not supported');
        const raw = await withSendTimeout(chat.removeParticipants(participants), GROUP_OP_TIMEOUT_MS, 'remove-participants');
        return participantResults(raw, participants);
      },
      promoteParticipants: async (jid, participants) => {
        const chat = await group(jid);
        if (typeof chat.promoteParticipants !== 'function') throw new Error('whatsapp-webjs: promoteParticipants not supported');
        const raw = await withSendTimeout(chat.promoteParticipants(participants), GROUP_OP_TIMEOUT_MS, 'promote-participants');
        return participantResults(raw, participants);
      },
      demoteParticipants: async (jid, participants) => {
        const chat = await group(jid);
        if (typeof chat.demoteParticipants !== 'function') throw new Error('whatsapp-webjs: demoteParticipants not supported');
        const raw = await withSendTimeout(chat.demoteParticipants(participants), GROUP_OP_TIMEOUT_MS, 'demote-participants');
        return participantResults(raw, participants);
      },
      setGroupSubject: async (jid, subject) => {
        const chat = await group(jid);
        if (typeof chat.setSubject !== 'function') throw new Error('whatsapp-webjs: setSubject not supported');
        await withSendTimeout(Promise.resolve(chat.setSubject(subject)), GROUP_OP_TIMEOUT_MS, 'set-subject');
      },
      setGroupDescription: async (jid, description) => {
        const chat = await group(jid);
        if (typeof chat.setDescription !== 'function') throw new Error('whatsapp-webjs: setDescription not supported');
        await withSendTimeout(Promise.resolve(chat.setDescription(description)), GROUP_OP_TIMEOUT_MS, 'set-description');
      },
      setGroupSetting: async (jid, setting) => {
        const chat = await group(jid);
        if (setting === 'announcement' || setting === 'not_announcement') {
          if (typeof chat.setMessagesAdminsOnly !== 'function') throw new Error('whatsapp-webjs: setMessagesAdminsOnly not supported');
          await withSendTimeout(Promise.resolve(chat.setMessagesAdminsOnly(setting === 'announcement')), GROUP_OP_TIMEOUT_MS, 'group-setting');
        } else {
          if (typeof chat.setInfoAdminsOnly !== 'function') throw new Error('whatsapp-webjs: setInfoAdminsOnly not supported');
          await withSendTimeout(Promise.resolve(chat.setInfoAdminsOnly(setting === 'locked')), GROUP_OP_TIMEOUT_MS, 'group-setting');
        }
      },
      getInviteCode: async (jid) => {
        const chat = await group(jid);
        if (typeof chat.getInviteCode !== 'function') throw new Error('whatsapp-webjs: getInviteCode not supported (are you a group admin?)');
        return withSendTimeout(chat.getInviteCode(), GROUP_OP_TIMEOUT_MS, 'invite-code');
      },
      revokeInviteCode: async (jid) => {
        const chat = await group(jid);
        if (typeof chat.revokeInvite !== 'function') throw new Error('whatsapp-webjs: revokeInvite not supported');
        return withSendTimeout(chat.revokeInvite(), GROUP_OP_TIMEOUT_MS, 'revoke-invite');
      },
      joinGroup: async (inviteCodeOrLink) => {
        const c = need(client(), 'acceptInvite');
        const code = extractInviteCode(inviteCodeOrLink);
        const groupJid = await withSendTimeout(c.acceptInvite!(code), GROUP_OP_TIMEOUT_MS, 'join-group');
        return groupJid ? { groupJid } : {};
      },
      inviteInfo: async (inviteCodeOrLink) => {
        const c = need(client(), 'getInviteInfo');
        const code = extractInviteCode(inviteCodeOrLink);
        return toInfo(await withSendTimeout(c.getInviteInfo!(code), GROUP_OP_TIMEOUT_MS, 'invite-info'));
      },
      checkOnWhatsApp: async (numbers) => {
        const c = need(client(), 'getNumberId');
        const out: WhatsAppNumberCheck[] = [];
        for (const input of numbers) {
          const digits = input.replace(/[^0-9]/g, '');
          try {
            const id = await withSendTimeout(c.getNumberId!(digits), GROUP_OP_TIMEOUT_MS, 'check-number');
            const jid = id?._serialized;
            out.push({ input, exists: !!jid, ...(jid ? { jid } : {}) });
          } catch {
            out.push({ input, exists: false });
          }
        }
        return out;
      },
      getProfilePicture: async (jid) => {
        const c = need(client(), 'getProfilePicUrl');
        const url = await withSendTimeout(c.getProfilePicUrl!(jid), GROUP_OP_TIMEOUT_MS, 'profile-picture');
        return url ?? null;
      },
      blockContact: async (jid) => {
        const c = need(client(), 'getContactById');
        const contact = await withSendTimeout(c.getContactById!(jid), GROUP_OP_TIMEOUT_MS, 'get-contact');
        if (typeof contact.block !== 'function') throw new Error('whatsapp-webjs: block not supported');
        await withSendTimeout(Promise.resolve(contact.block()), GROUP_OP_TIMEOUT_MS, 'block');
      },
      unblockContact: async (jid) => {
        const c = need(client(), 'getContactById');
        const contact = await withSendTimeout(c.getContactById!(jid), GROUP_OP_TIMEOUT_MS, 'get-contact');
        if (typeof contact.unblock !== 'function') throw new Error('whatsapp-webjs: unblock not supported');
        await withSendTimeout(Promise.resolve(contact.unblock()), GROUP_OP_TIMEOUT_MS, 'unblock');
      },
      getStatus: async (jid) => {
        const c = need(client(), 'getContactById');
        const contact = await withSendTimeout(c.getContactById!(jid), GROUP_OP_TIMEOUT_MS, 'get-contact');
        if (typeof contact.getAbout !== 'function') return null;
        const about = await withSendTimeout(Promise.resolve(contact.getAbout()), GROUP_OP_TIMEOUT_MS, 'about');
        return about ?? null;
      },
      setOwnName: async (name) => {
        const c = need(client(), 'setDisplayName');
        await withSendTimeout(Promise.resolve(c.setDisplayName!(name)), GROUP_OP_TIMEOUT_MS, 'set-name');
      },
      setOwnStatus: async (status) => {
        const c = need(client(), 'setStatus');
        await withSendTimeout(Promise.resolve(c.setStatus!(status)), GROUP_OP_TIMEOUT_MS, 'set-status');
      },
      sendReaction: async (_jid, messageId, emoji) => {
        const c = need(client(), 'getMessageById');
        const msg = await withSendTimeout(c.getMessageById!(messageId), GROUP_OP_TIMEOUT_MS, 'get-message');
        if (typeof msg.react !== 'function') throw new Error('whatsapp-webjs: react not supported');
        await withSendTimeout(Promise.resolve(msg.react(emoji)), GROUP_OP_TIMEOUT_MS, 'react');
      },
      sendLocation: async (jid, latitude, longitude, name) => {
        if (typeof this.adapter.location !== 'function') {
          throw new Error('whatsapp-webjs: location not supported by this adapter build');
        }
        const body = this.adapter.location({ latitude, longitude, ...(name ? { name } : {}) });
        return this.sendRaw(jid, body);
      },
    };
  }

  /** Send a pre-built whatsapp-web.js message body (e.g. a Location). */
  private async sendRaw(chatId: string, body: unknown): Promise<string | undefined> {
    this.assertConnected('sendRaw');
    const res = await withSendTimeout(this.client!.sendMessage(chatId, body), SEND_TIMEOUT_TEXT_MS, 'raw');
    return res?.id?._serialized;
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
    location(args) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const { Location } = require('whatsapp-web.js') as {
        Location: new (lat: number, lng: number, name?: string) => unknown;
      };
      return new Location(args.latitude, args.longitude, args.name);
    },
  };
}

/** Bare digits from a wid/serialized id (`601123@c.us` → `601123`). */
function bareDigitsFromId(id: string | null | undefined): string | null {
  if (!id) return null;
  const head = id.split('@')[0] ?? '';
  const num = (head.split(':')[0] ?? '').replace(/[^0-9]/g, '');
  return num.length > 0 ? num : null;
}

/** Extract a group invite code from a bare code or a full
 *  https://chat.whatsapp.com/<code> link. */
export function extractInviteCode(input: string): string {
  const m = input.match(/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]+)/i);
  return m ? m[1]! : input.trim();
}

/** Normalise a whatsapp-web.js GroupChat (or getInviteInfo node) into the
 *  stable WhatsAppGroupInfo shape, computing selfIsAdmin from own digits. */
function normalizeGroupInfo(
  chat: WebJsGroupChatHandle,
  selfDigits: string | null,
): WhatsAppGroupInfo {
  const participants = (chat.participants ?? []).map((p) => ({
    jid: p.id?._serialized ?? '',
    admin: p.isSuperAdmin ? ('superadmin' as const) : p.isAdmin ? ('admin' as const) : null,
  }));
  const selfIsAdmin = selfDigits
    ? participants.some((p) => bareDigitsFromId(p.jid) === selfDigits && p.admin != null)
    : false;
  return {
    jid: chat.id?._serialized ?? '',
    subject: chat.subject ?? chat.name ?? '',
    participantCount: chat.groupMetadata?.size ?? participants.length,
    selfIsAdmin,
    announce: chat.groupMetadata?.announce ?? false,
    restrict: chat.groupMetadata?.restrict ?? false,
    participants,
    ...(chat.owner?._serialized ? { owner: chat.owner._serialized } : {}),
    ...(chat.description ? { description: chat.description } : {}),
    ...(chat.groupMetadata?.creation ? { creation: chat.groupMetadata.creation } : {}),
  };
}

/** Normalise whatsapp-web.js participant-mutation results (an object map
 *  keyed by participant id → { code, message }) into [{jid,status}]. */
function participantResults(raw: unknown, requested: string[]): WhatsAppParticipantResult[] {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.length > 0) {
      return entries.map(([jid, v]) => {
        const rec = (v ?? {}) as { code?: number | string; message?: string };
        return { jid, status: String(rec.code ?? rec.message ?? 'ok') };
      });
    }
  }
  return requested.map((jid) => ({ jid, status: 'ok' }));
}
