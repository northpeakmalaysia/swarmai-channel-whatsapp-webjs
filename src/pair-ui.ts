import { WebJsClient, type WebJsAdapter } from './webjs-client.js';
import { WhatsAppWebJsConfigSchema, type WhatsAppWebJsConfig } from './types.js';

/**
 * UI-driven pair flow for WhatsApp Web.js — emitter-based variant of
 * `runPairFlow` (pair-flow.ts) for browser-side pairing in the dashboard.
 *
 * Mirrors `runWhatsAppPersonalPairForUi` from the Baileys sibling plugin
 * so the server-side router (apps/server/src/api/channel-pair.ts) can
 * register both runners with the same control contract:
 *   - `emitter.onEvent` receives every state transition
 *   - `submit2fa` is a no-op (WhatsApp doesn't have a cloud-password 2FA)
 *   - `cancel` aborts the underlying client
 *
 * Web.js-specific differences from Baileys:
 *   - Cold-start is slower (~10-30 s vs ~5 s) because Web.js spawns a
 *     full Chromium via puppeteer-core before the WhatsApp socket comes
 *     up. Overall timeout is bumped to 6 min (vs 5 min for Baileys) to
 *     leave headroom for the launch.
 *   - The `qr` event fires after `launching`; no additional pre-QR
 *     transition is surfaced (the operator just sees a delay).
 *   - `session-expired` fires both during pair (when the QR scan is
 *     rejected) and after a successful pair (when the WhatsApp Web
 *     session gets logged out by the phone). Only the pre-success
 *     variant terminates the pair flow.
 */

export type PairEvent =
  | {
      kind: 'qr-ready';
      qrPayload: string;
      expiresAt: string;
    }
  | { kind: 'scanned' }
  | { kind: 'need-2fa' }
  | {
      kind: 'success';
      username: string;
      sessionString: string;
    }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'cancelled' };

export interface PairEventEmitter {
  onEvent(event: PairEvent): void;
}

export interface WhatsAppWebJsPairUiResult {
  username: string;
  sessionString: string;
  /** Resolved Web.js session dir (vault-side persistence reference). */
  sessionDir: string;
}

export interface WhatsAppWebJsPairUiOptions {
  config?: Partial<WhatsAppWebJsConfig> & { sessionId?: string };
  adapter?: WebJsAdapter;
  emitter: PairEventEmitter;
  signal?: AbortSignal;
  /** Per-QR TTL in ms — Web.js rotates QRs at ~20s (faster than Baileys). */
  qrTtlMs?: number;
  /** Overall timeout (default 6 min — Web.js cold-start eats ~30s up front). */
  timeoutMs?: number;
}

export interface PairController<TResult> {
  promise: Promise<TResult>;
  submit2fa(password: string): void;
  cancel(): void;
}

/**
 * Drive the Web.js QR pair flow with browser-friendly events. The
 * returned controller's `promise` resolves with the final result
 * envelope. The emitter receives every state transition; `submit2fa`
 * is a no-op.
 */
export function runWhatsAppWebJsPairForUi(
  opts: WhatsAppWebJsPairUiOptions,
): PairController<WhatsAppWebJsPairUiResult> {
  const config = WhatsAppWebJsConfigSchema.parse({
    sessionId: opts.config?.sessionId ?? 'pending-pair',
    ...opts.config,
  });
  const qrTtlMs = opts.qrTtlMs ?? 20_000;
  const timeoutMs = opts.timeoutMs ?? 360_000; // 6 min absolute cap.

  const client = new WebJsClient({
    config,
    ...(opts.adapter ? { adapter: opts.adapter } : {}),
  });

  let resolved = false;
  let cancelled = false;

  let resolveOuter!: (r: WhatsAppWebJsPairUiResult) => void;
  let rejectOuter!: (err: Error) => void;
  const outer = new Promise<WhatsAppWebJsPairUiResult>((res, rej) => {
    resolveOuter = res;
    rejectOuter = rej;
  });

  let timeoutHandle: NodeJS.Timeout | null = null;
  const safeEmit = (ev: PairEvent): void => {
    try {
      opts.emitter.onEvent(ev);
    } catch {
      // emitter must never break the flow
    }
  };

  const cleanup = (): void => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    client.removeAllListeners('qr');
    client.removeAllListeners('connected');
    client.removeAllListeners('session-expired');
    client.removeAllListeners('error');
    void client.stop().catch(() => {
      // best-effort
    });
  };

  const finish = (result: WhatsAppWebJsPairUiResult): void => {
    if (resolved) return;
    resolved = true;
    cleanup();
    safeEmit({
      kind: 'success',
      username: result.username,
      sessionString: result.sessionString,
    });
    resolveOuter(result);
  };

  const fail = (code: string, message: string): void => {
    if (resolved) return;
    resolved = true;
    cleanup();
    if (cancelled) {
      safeEmit({ kind: 'cancelled' });
    } else {
      safeEmit({ kind: 'error', code, message });
    }
    rejectOuter(new Error(`${code}: ${message}`));
  };

  client.on('qr', (qr) => {
    safeEmit({
      kind: 'qr-ready',
      qrPayload: qr as string,
      expiresAt: new Date(Date.now() + qrTtlMs).toISOString(),
    });
  });

  client.on('connected', (payload) => {
    const { phoneNumber } = payload as { phoneNumber: string | null };
    safeEmit({ kind: 'scanned' });
    const phone = phoneNumber ?? 'unknown';
    finish({
      username: phone,
      sessionString: phone,
      sessionDir: config.sessionDir ?? '',
    });
  });

  client.on('session-expired', (payload) => {
    const { detail } = payload as { detail?: string };
    fail(
      'session-expired',
      `pairing rejected — phone may have logged this device out (${detail ?? 'no detail'})`,
    );
  });

  client.on('error', (err) => {
    fail('client-error', err instanceof Error ? err.message : String(err));
  });

  timeoutHandle = setTimeout(() => {
    fail(
      'timeout',
      `pairing timed out after ${Math.round(timeoutMs / 1000)}s — Web.js cold-start can be slow; re-open the modal to retry`,
    );
  }, timeoutMs);

  if (opts.signal) {
    if (opts.signal.aborted) {
      cancelled = true;
      queueMicrotask(() => fail('cancelled', 'aborted before start'));
    } else {
      opts.signal.addEventListener(
        'abort',
        () => {
          cancelled = true;
          fail('cancelled', 'aborted by caller');
        },
        { once: true },
      );
    }
  }

  void client.start().catch((err) => {
    fail(
      'start-failed',
      err instanceof Error ? err.message : String(err),
    );
  });

  return {
    promise: outer,
    submit2fa(_password: string): void {
      // No-op — WhatsApp doesn't have a 2FA cloud password.
    },
    cancel(): void {
      if (resolved) return;
      cancelled = true;
      fail('cancelled', 'cancelled by user');
    },
  };
}
