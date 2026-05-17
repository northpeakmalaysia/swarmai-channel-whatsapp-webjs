import type {
  ChannelPlugin,
  ChannelContext,
  ChannelEmit,
  ChannelFeatures,
  ChannelHealth,
  OutboundEvent,
  InboundEvent,
  HttpRequest,
  MonitorEvent,
  MonitorSource,
} from '@swarmai/plugin-sdk';
import { logger as sharedLogger } from '@swarmai/shared';
import {
  WhatsAppWebJsConfigSchema,
  WhatsAppWebJsAuthSchema,
  type WhatsAppWebJsConfig,
} from './types.js';
import { WebJsClient, type WebJsAdapter } from './webjs-client.js';
import { normaliseWebJsMessage } from './inbound-normaliser.js';
import { sendOutbound } from './outbound-sender.js';

/**
 * Per-attachment cap for auto-downloaded WhatsApp media. Mirrors the
 * Baileys plugin so an operator switching adapters doesn't see a
 * different ceiling.
 */
const MAX_WA_MEDIA_BYTES = 5 * 1024 * 1024;

/**
 * `@swarmai/channel-whatsapp-webjs` — whatsapp-web.js-based WhatsApp
 * adapter. Sibling to `@swarmai/channel-whatsapp-baileys` (Baileys
 * direct-WebSocket) and `@swarmai/channel-whatsapp` (Cloud API).
 *
 * Channel kind: `whatsapp-webjs` (NEW). Designed to coexist with the
 * Baileys variant — both can be paired to the same WhatsApp account via
 * Multi-Device, and the agent picks the right one per send (text →
 * Baileys for speed, media → Web.js for reliability).
 */

export const WHATSAPP_WEBJS_FEATURES: ChannelFeatures = {
  dm: true,
  group: true,
  thread: false,
  reaction: true,
  edit: false,
  delete: false,
  mediaImage: true,
  mediaVideo: true,
  mediaAudio: true,
  voiceMemo: true,
  voiceCall: false,
  typing: true,
  readReceipt: true,
  formatting: 'platform',
  maxMessageBytes: 65536,
  maxAttachmentBytes: 100 * 1024 * 1024,
  rateLimit: { perMinute: 30, perHour: 500 },
};

export interface WhatsAppWebJsPluginOptions {
  /** Inject the Web.js adapter (tests). */
  adapter?: WebJsAdapter;
  /** Alt-path inbound hook — called for every inbound event. */
  onEvent?: (e: InboundEvent) => void | Promise<void>;
  /** Connection-lifecycle listener — surfaces session-down etc. */
  onConnectionEvent?: (event: WhatsAppWebJsConnectionEvent) => void;
  /** Operator's friendly name (e.g. `Athena`) for @-mention detection. */
  selfDisplayName?: string;
  /**
   * Override the channel + source identifier so one factory can produce
   * multiple slots. Defaults to `DEFAULT_WHATSAPP_WEBJS_ID`.
   */
  channelId?: string;
}

export type WhatsAppWebJsConnectionEvent =
  | { kind: 'launching' }
  | { kind: 'qr'; qr: string }
  | { kind: 'authenticated' }
  | { kind: 'connected'; phoneNumber: string | null }
  | { kind: 'reconnecting'; attempt: number; delayMs: number }
  | { kind: 'disconnected'; reason: 'logged-out' | 'transient'; detail?: string }
  | { kind: 'session-expired'; detail?: string }
  | { kind: 'session-down'; attempts: number };

export interface WhatsAppWebJsBundle {
  channel: ChannelPlugin;
  source: MonitorSource;
  getClient(): WebJsClient | null;
  handleWebhook(req: HttpRequest): Promise<{
    status: number;
    body: string;
    inbound: InboundEvent[];
  }>;
  sendTyping(to: string): Promise<void>;
}

export const DEFAULT_WHATSAPP_WEBJS_ID = 'whatsapp-webjs';

const SLOT_ID_RE = /^[a-z0-9][a-z0-9._:-]*$/;

function assertValidChannelId(id: string): void {
  if (!SLOT_ID_RE.test(id)) {
    throw new Error(
      `whatsapp-webjs: invalid channelId "${id}" — must match ${SLOT_ID_RE}`,
    );
  }
}

export function createWhatsAppWebJsPlugin(
  opts: WhatsAppWebJsPluginOptions = {},
): WhatsAppWebJsBundle {
  const channelId = opts.channelId ?? DEFAULT_WHATSAPP_WEBJS_ID;
  assertValidChannelId(channelId);

  let started = false;
  let config: WhatsAppWebJsConfig | null = null;
  let emit: ChannelEmit | null = null;
  let client: WebJsClient | null = null;
  let lastConnectionEvent: WhatsAppWebJsConnectionEvent | null = null;

  const channel: ChannelPlugin = {
    id: channelId,
    displayName: 'WhatsApp (Web.js)',
    description: 'WhatsApp Web via whatsapp-web.js (puppeteer-driven) — pair via QR with your phone. Heavier but media-reliable.',
    version: '0.1.0',
    kind: 'both',
    defaultDmPolicy: 'pairing',
    features: WHATSAPP_WEBJS_FEATURES,
    authSchema: WhatsAppWebJsAuthSchema,
    configSchema: WhatsAppWebJsConfigSchema,

    async start(ctx: ChannelContext, emitFn: ChannelEmit): Promise<void> {
      config = WhatsAppWebJsConfigSchema.parse(ctx.config ?? {});
      emit = emitFn;
      WhatsAppWebJsAuthSchema.parse(ctx.secrets ?? {});

      client = new WebJsClient({
        config,
        ...(opts.adapter ? { adapter: opts.adapter } : {}),
      });

      client.on('launching', () => {
        const e: WhatsAppWebJsConnectionEvent = { kind: 'launching' };
        lastConnectionEvent = e;
        opts.onConnectionEvent?.(e);
      });
      client.on('qr', (qr: string) => {
        const e: WhatsAppWebJsConnectionEvent = { kind: 'qr', qr };
        lastConnectionEvent = e;
        opts.onConnectionEvent?.(e);
        sharedLogger.warn(
          'whatsapp-webjs: QR pairing required — re-run `swarmai setup` or use the dashboard Pair button',
        );
      });
      client.on('authenticated', () => {
        const e: WhatsAppWebJsConnectionEvent = { kind: 'authenticated' };
        lastConnectionEvent = e;
        opts.onConnectionEvent?.(e);
      });
      client.on('connected', ({ phoneNumber }: { phoneNumber: string | null }) => {
        const e: WhatsAppWebJsConnectionEvent = { kind: 'connected', phoneNumber };
        lastConnectionEvent = e;
        opts.onConnectionEvent?.(e);
        sharedLogger.info({ phoneNumber }, 'whatsapp-webjs: connected');
      });
      client.on('reconnecting', ({ attempt, delayMs }: { attempt: number; delayMs: number }) => {
        const e: WhatsAppWebJsConnectionEvent = { kind: 'reconnecting', attempt, delayMs };
        lastConnectionEvent = e;
        opts.onConnectionEvent?.(e);
      });
      client.on('disconnected', (info: { reason: 'logged-out' | 'transient'; detail?: string }) => {
        const e: WhatsAppWebJsConnectionEvent = {
          kind: 'disconnected',
          reason: info.reason,
          ...(info.detail ? { detail: info.detail } : {}),
        };
        lastConnectionEvent = e;
        opts.onConnectionEvent?.(e);
      });
      client.on('session-expired', (info: { detail?: string }) => {
        const e: WhatsAppWebJsConnectionEvent = {
          kind: 'session-expired',
          ...(info.detail ? { detail: info.detail } : {}),
        };
        lastConnectionEvent = e;
        opts.onConnectionEvent?.(e);
        sharedLogger.warn(
          { detail: info.detail },
          'whatsapp-webjs: session expired — re-pair via dashboard',
        );
      });
      client.on('session-down', ({ attempts }: { attempts: number }) => {
        const e: WhatsAppWebJsConnectionEvent = { kind: 'session-down', attempts };
        lastConnectionEvent = e;
        opts.onConnectionEvent?.(e);
        sharedLogger.warn({ attempts }, 'whatsapp-webjs: gave up reconnecting');
      });
      client.on('error', (err: unknown) => {
        sharedLogger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'whatsapp-webjs: client error',
        );
      });

      client.on('message', async (msg) => {
        try {
          const ev = normaliseWebJsMessage(channelId, msg, {
            ...(client?.getOwnId() ? { selfChatId: client.getOwnId()! } : {}),
            ...(opts.selfDisplayName ? { selfDisplayName: opts.selfDisplayName } : {}),
          });
          if (!ev) return;

          // Auto-download inbound media for images + documents (mirrors
          // Baileys plugin's policy — audio/video stay metadata-only).
          if (ev.attachments && ev.attachments.length > 0 && client) {
            for (const att of ev.attachments) {
              if (att.kind !== 'image' && att.kind !== 'file') continue;
              const bytes = await client.downloadMedia(msg);
              if (!bytes) continue;
              if (bytes.byteLength > MAX_WA_MEDIA_BYTES) {
                sharedLogger.warn(
                  {
                    channelId,
                    kind: att.kind,
                    sizeBytes: bytes.byteLength,
                    capBytes: MAX_WA_MEDIA_BYTES,
                  },
                  'whatsapp-webjs: inbound media exceeds cap, skipping download',
                );
                continue;
              }
              att.data = bytes;
            }
          }

          const isGroup = ev.flags?.['groupChat'] === true;
          const wasMentioned = ev.flags?.['mentioned'] === true;
          const shouldRouteToBridge =
            !isGroup || !config!.respondToMentions || wasMentioned;
          if (shouldRouteToBridge && emit) await emit(ev);
          if (opts.onEvent) await opts.onEvent(ev);

          if (config?.markRead) {
            await client?.markRead(msg.from);
          }
        } catch (err) {
          sharedLogger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'whatsapp-webjs: inbound handler threw',
          );
        }
      });

      await client.start();
      started = true;
    },

    async stop(): Promise<void> {
      if (client) {
        await client.stop();
        client = null;
      }
      started = false;
      emit = null;
    },

    async healthCheck(): Promise<ChannelHealth> {
      if (!started || !client) return { status: 'down', detail: 'not started' };
      const status = client.getStatus();
      switch (status) {
        case 'connected':
          return { status: 'ok' };
        case 'launching':
        case 'qr':
        case 'authenticated':
        case 'reconnecting':
          return { status: 'degraded', detail: status };
        case 'session-expired':
        case 'session-down':
        case 'idle':
        default:
          return { status: 'down', detail: status };
      }
    },

    async send(event: OutboundEvent): Promise<void> {
      if (!started || !client || !config) {
        throw new Error('whatsapp-webjs channel not started');
      }
      if (event.channelId !== channelId) {
        throw new Error(
          `channelId mismatch: got ${event.channelId}, expected ${channelId}`,
        );
      }
      const result = await sendOutbound(
        {
          client,
          channelId,
          ...(config.typingIndicator
            ? {
                onBeforeSend: (chatId: string) => client!.setTyping(chatId, true),
                onAfterSend: (chatId: string) => client!.setTyping(chatId, false),
              }
            : {}),
        },
        event,
      );
      if (!result.ok) {
        throw new Error(`whatsapp-webjs send failed: ${result.detail ?? 'unknown'}`);
      }
    },
  };

  const sendTypingHook = async (to: string): Promise<void> => {
    if (!started || !client || !config) return;
    if (!config.typingIndicator) return;
    await client.setTyping(to, true);
  };

  const source: MonitorSource = {
    id: channelId,
    kind: 'push',
    authSchema: WhatsAppWebJsAuthSchema,
    configSchema: WhatsAppWebJsConfigSchema,
    async healthCheck() {
      if (!started || !client) return 'down';
      const s = client.getStatus();
      return s === 'connected'
        ? 'ok'
        : s === 'session-down' || s === 'session-expired'
          ? 'down'
          : 'degraded';
    },
    async webhook(_req: HttpRequest): Promise<MonitorEvent[]> {
      // Personal mode is WS-native — no inbound HTTP path.
      return [];
    },
  };

  function handleWebhook(_req: HttpRequest): Promise<{
    status: number;
    body: string;
    inbound: InboundEvent[];
  }> {
    return Promise.resolve({
      status: 405,
      body: '{"error":"whatsapp-webjs has no webhook"}',
      inbound: [],
    });
  }

  return {
    channel,
    source,
    handleWebhook,
    getClient: () => client,
    sendTyping: sendTypingHook,
    ...({} as { _lastEvent?: () => WhatsAppWebJsConnectionEvent | null }),
    _lastEvent: () => lastConnectionEvent,
  } as WhatsAppWebJsBundle & { _lastEvent: () => WhatsAppWebJsConnectionEvent | null };
}

/**
 * MonitorSource-only factory — returns just the source half of the
 * bundle. Mirrors the Baileys plugin's pattern.
 */
export function createWhatsAppWebJsMonitorSource(
  opts: WhatsAppWebJsPluginOptions = {},
): MonitorSource {
  return createWhatsAppWebJsPlugin(opts).source;
}

/**
 * Monitor-only bundle — `send()` throws so the slot is inbound-only at
 * the contract level. Used by Phase 11 multi-slot configurations.
 */
export class MonitorOnlySlotError extends Error {
  constructor(channelId: string) {
    super(
      `whatsapp-webjs: slot "${channelId}" is monitor-only — outbound not allowed. ` +
        `Use the primary "whatsapp-webjs" channel slot for replies.`,
    );
    this.name = 'MonitorOnlySlotError';
  }
}

export function createWhatsAppWebJsMonitorOnlyBundle(
  opts: WhatsAppWebJsPluginOptions = {},
): WhatsAppWebJsBundle {
  const base = createWhatsAppWebJsPlugin(opts);
  const channelId = opts.channelId ?? DEFAULT_WHATSAPP_WEBJS_ID;
  const monitorChannel: ChannelPlugin = {
    ...base.channel,
    kind: 'monitor-source',
    features: {
      ...base.channel.features,
      dm: false,
      group: false,
    },
    async send(): Promise<void> {
      throw new MonitorOnlySlotError(channelId);
    },
  };
  return {
    ...base,
    channel: monitorChannel,
  };
}
