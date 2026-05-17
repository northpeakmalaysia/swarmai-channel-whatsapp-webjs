import { z } from '@swarmai/shared';

/**
 * `@swarmai/channel-whatsapp-webjs` — whatsapp-web.js (puppeteer) adapter.
 *
 * Sibling to `@swarmai/channel-whatsapp-baileys` and `@swarmai/channel-whatsapp`
 * (Cloud API). All three implement the same `ChannelPlugin` contract.
 *
 * Web.js drives the real WhatsApp Web client inside a headless Chromium
 * process. Heavier than Baileys (persistent Chrome ≈ 300 MB) but reliable
 * for media uploads in daemon contexts where Baileys' separate
 * `mmg.whatsapp.net` HTTPS path stalls.
 *
 * Session storage: a persistent Chromium user-data-dir at
 * `<workspace>/.swarmai/webjs/profile/<sessionId>/`. whatsapp-web.js'
 * `LocalAuth` strategy writes its own subfolder there.
 */

export const WhatsAppWebJsConfigSchema = z.object({
  /**
   * Session identifier — typically the operator's phone number once
   * paired. Used as the folder name under `<workspace>/.swarmai/webjs/profile/`.
   * Falls back to `default` for the first run before pairing completes.
   */
  sessionId: z.string().min(1).default('default'),
  /**
   * Absolute path to the Chromium user-data-dir. When unset the plugin
   * derives it from `<workspace>/.swarmai/webjs/profile/<sessionId>/`.
   */
  sessionDir: z.string().optional(),
  /**
   * Absolute path to the Chrome / Chromium / Edge executable. When
   * unset the plugin probes the host using SwarmAI's standard
   * detection (the same probe the PDF generator uses). Override only
   * when you have a non-standard install location.
   */
  chromiumExecutablePath: z.string().optional(),
  /**
   * Mark messages as read after the inbound handler resolves.
   * Defaults to true so the operator's phone doesn't accumulate
   * unread badges.
   */
  markRead: z.boolean().default(true),
  /**
   * Send a typing indicator while the agent is composing a reply.
   * Defaults to true.
   */
  typingIndicator: z.boolean().default(true),
  /**
   * Reconnect backoff base (ms). Doubles each consecutive failure up
   * to `reconnectMaxBackoffMs`. Default 2000 (2s — Chrome restart
   * costs more than a Baileys reconnect, so we back off harder).
   */
  reconnectBaseBackoffMs: z.number().int().positive().default(2_000),
  /** Reconnect backoff cap (ms). Default 60000 (60s). */
  reconnectMaxBackoffMs: z.number().int().positive().default(60_000),
  /**
   * After this many consecutive failures, give up reconnecting and emit
   * a `channel.session-down` event. Default 5.
   */
  reconnectMaxAttempts: z.number().int().positive().default(5),
  /**
   * When true, group messages that @-mention the operator's own number
   * are routed through the normal reply path (`flags.mentioned = true`).
   * Otherwise group messages flow only through the monitor side-channel.
   * Defaults to true on Personal mode — the operator scanned the QR.
   */
  respondToMentions: z.boolean().default(true),
  /**
   * Heartbeat interval for the session-dir lockfile (ms). Each tick
   * rewrites `.swarmai-lock` with the current timestamp. Default 30s.
   */
  lockHeartbeatMs: z.number().int().positive().default(30_000),
  /**
   * Stale threshold for the session-dir lockfile (ms). Older than this
   * and a peer process may take over the lock. Default 90s.
   */
  lockStaleMs: z.number().int().positive().default(90_000),
  /**
   * Headless mode. Defaults to true. Set false only for local debugging
   * (you'll see the Chrome window with WhatsApp Web inside it).
   */
  headless: z.boolean().default(true),
});

/**
 * Personal mode has no auth secrets — credentials live inside the
 * Chromium user-data-dir. Schema kept empty for structural compat
 * with the Cloud variant.
 */
export const WhatsAppWebJsAuthSchema = z.object({}).passthrough();

export type WhatsAppWebJsConfig = z.infer<typeof WhatsAppWebJsConfigSchema>;
export type WhatsAppWebJsAuth = z.infer<typeof WhatsAppWebJsAuthSchema>;

/**
 * Structural subset of whatsapp-web.js' `Message` shape that we consume.
 * We declare it here instead of importing from whatsapp-web.js so this
 * package parses/typechecks without the heavy puppeteer dep installed
 * (whatsapp-web.js is a peer dep, lazy-loaded).
 */
export interface WebJsMessage {
  id: { id: string; remote?: string; fromMe?: boolean; _serialized?: string };
  from: string;
  to?: string;
  body: string;
  /** WhatsApp message type: 'chat' | 'image' | 'video' | 'audio' | 'ptt' |
   *  'document' | 'sticker' | 'location' | 'vcard' | 'multi_vcard' | etc. */
  type: string;
  timestamp: number;
  /** pushName — contact's display name as they set it on their client. */
  notifyName?: string;
  /** Author (group sender). Only set on group messages — `from` is the group JID. */
  author?: string;
  /** True iff this is a group message. */
  isGroupMsg?: boolean;
  /** Array of mentioned contact ids (with @c.us suffix). */
  mentionedIds?: string[];
  /** Whether the message has media that we can download. */
  hasMedia?: boolean;
  /** Filename for document attachments. */
  filename?: string;
  /** Mimetype for media. */
  mimetype?: string;
  /** Best-effort: caption for image / video / document messages. */
  caption?: string;
  /** Downloadable media handle — `downloadMedia()` returns a MessageMedia. */
  downloadMedia?: () => Promise<{
    mimetype: string;
    data: string;
    filename?: string;
    filesize?: number;
  } | null>;
  /** Mark this message read. */
  getChat?: () => Promise<{ sendSeen: () => Promise<void> }>;
}

/**
 * Connection status emitted by the Web.js client wrapper. Mirrors the
 * Baileys plugin's status enum so the bridge / health checks can treat
 * both adapters identically.
 */
export type WhatsAppWebJsConnectionStatus =
  | 'idle'
  | 'launching'
  | 'qr'
  | 'authenticated'
  | 'connected'
  | 'reconnecting'
  | 'session-expired'
  | 'session-down';
