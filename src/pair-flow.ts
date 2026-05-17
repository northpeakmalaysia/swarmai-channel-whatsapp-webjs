import { WebJsClient, type WebJsAdapter } from './webjs-client.js';
import { renderQr } from './qr-display.js';
import { WhatsAppWebJsConfigSchema, type WhatsAppWebJsConfig } from './types.js';

/**
 * Pair-flow orchestrator — drives the QR loop until the operator
 * scans with their phone or the timeout elapses.
 *
 * One-shot: each call instantiates a fresh Client, drives it to
 * `connected`, and stops it. Callers that want a persistent channel
 * use the plugin (`createWhatsAppWebJsPlugin`) directly.
 */

export interface PairFlowOptions {
  config: Partial<WhatsAppWebJsConfig> & { sessionId?: string };
  adapter?: WebJsAdapter;
  onQr?: (qr: string) => void | Promise<void>;
  onInfo?: (msg: string) => void;
  /**
   * Pairing timeout in ms. Default 120_000 — Web.js cold-start takes
   * ~10-30s before the QR appears, so we give more headroom than the
   * Baileys plugin (60s).
   */
  timeoutMs?: number;
}

export interface PairFlowResult {
  phoneNumber: string;
  sessionDir: string;
  sessionId: string;
}

export async function runPairFlow(opts: PairFlowOptions): Promise<PairFlowResult> {
  const config = WhatsAppWebJsConfigSchema.parse({
    sessionId: opts.config.sessionId ?? 'pending-pair',
    ...opts.config,
  });

  const info = opts.onInfo ?? defaultInfo;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const client = new WebJsClient({
    config,
    ...(opts.adapter ? { adapter: opts.adapter } : {}),
  });

  let qrTimeout: NodeJS.Timeout | null = null;
  let resolved = false;

  return new Promise<PairFlowResult>((resolve, reject) => {
    const cleanup = (): void => {
      if (qrTimeout) {
        clearTimeout(qrTimeout);
        qrTimeout = null;
      }
      client.removeAllListeners('qr');
      client.removeAllListeners('connected');
      client.removeAllListeners('session-expired');
      client.removeAllListeners('error');
    };

    const finish = (err: Error | null, result: PairFlowResult | null): void => {
      if (resolved) return;
      resolved = true;
      cleanup();
      void client.stop();
      if (err) reject(err);
      else if (result) resolve(result);
      else reject(new Error('pair flow finished without result'));
    };

    qrTimeout = setTimeout(() => {
      finish(
        new Error(
          `whatsapp-webjs: QR pairing timed out after ${timeoutMs}ms — the QR ` +
            'code expired before scanning. Re-run setup to try again.',
        ),
        null,
      );
    }, timeoutMs);

    client.on('qr', async (qr) => {
      info('whatsapp-webjs: scan the QR code below with your phone (WhatsApp → Linked Devices → Link a Device)');
      if (opts.onQr) await opts.onQr(qr as string);
      else await renderQr(qr as string);
    });

    client.on('connected', ({ phoneNumber }: { phoneNumber: string | null }) => {
      info(`whatsapp-webjs: connected as ${phoneNumber ?? 'unknown'}`);
      finish(null, {
        phoneNumber: phoneNumber ?? '',
        sessionDir: config.sessionDir ?? '',
        sessionId: config.sessionId,
      });
    });

    client.on('session-expired', (info: { detail?: string }) => {
      finish(
        new Error(
          `whatsapp-webjs: session expired during pair (${info.detail ?? 'unknown'})`,
        ),
        null,
      );
    });

    client.on('error', (err: Error) => {
      finish(err, null);
    });

    void client.start().catch((err) => finish(err instanceof Error ? err : new Error(String(err)), null));
  });
}

function defaultInfo(msg: string): void {
  process.stderr.write(`${msg}\n`);
}
