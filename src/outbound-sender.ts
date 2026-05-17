import type { Attachment, OutboundEvent } from '@swarmai/plugin-sdk';
import type { WebJsClient } from './webjs-client.js';
import { normaliseForWhatsApp } from './format.js';

/**
 * Outbound — translate `OutboundEvent` into whatsapp-web.js sends.
 *
 * whatsapp-web.js uses `<digits>@c.us` for DMs and `<digits>-<ts>@g.us`
 * for groups (the standard WhatsApp Web ids). Accepts the same inputs
 * the Baileys plugin does (raw phone / @s.whatsapp.net / @c.us / @g.us)
 * and normalises to `@c.us` form before dispatch.
 *
 * Each attachment becomes a separate `sendMessage` call (matches the
 * Baileys plugin's per-attachment fan-out). First caption-bearing
 * attachment carries the body; subsequent attachments send without
 * caption to avoid duplication; if no attachment can carry the body
 * (audio-only fan-out) we trail with a plain text send.
 *
 * Size caps mirror the Baileys plugin so an operator switching
 * plugins doesn't suddenly hit a different ceiling:
 *   image / video / audio  : 16 MB
 *   document               : 100 MB
 */

export interface SendOutcome {
  ok: boolean;
  messageId?: string;
  detail?: string;
}

export interface OutboundDeps {
  client: WebJsClient;
  channelId: string;
  onBeforeSend?: (chatId: string) => Promise<void>;
  onAfterSend?: (chatId: string) => Promise<void>;
  fetchImpl?: (url: string) => Promise<{
    ok: boolean;
    status: number;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
}

export const MEDIA_SIZE_CAPS: Record<Attachment['kind'], number> = {
  image: 16 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  file: 100 * 1024 * 1024,
};

export async function sendOutbound(
  deps: OutboundDeps,
  event: OutboundEvent,
): Promise<SendOutcome> {
  if (event.channelId !== deps.channelId) {
    return {
      ok: false,
      detail: `channelId mismatch: got ${event.channelId}, expected ${deps.channelId}`,
    };
  }
  const hasAttachments = (event.attachments?.length ?? 0) > 0;
  if ((!event.body || event.body.length === 0) && !hasAttachments) {
    return { ok: false, detail: 'empty body — refusing to send' };
  }
  const body = event.body ? normaliseForWhatsApp(event.body) : event.body;
  const chatId = toChatId(event.to);
  if (!chatId) {
    return { ok: false, detail: `cannot resolve recipient chatId from "${event.to}"` };
  }
  if (deps.onBeforeSend) {
    try {
      await deps.onBeforeSend(chatId);
    } catch {
      /* typing-indicator failure is never fatal */
    }
  }

  let lastMessageId: string | undefined;
  let captionConsumed = false;
  try {
    if (hasAttachments) {
      for (const att of event.attachments ?? []) {
        const validation = validateAttachment(att);
        if (!validation.ok) {
          return { ok: false, detail: validation.detail };
        }
        let buffer: Buffer;
        try {
          buffer = await resolveMediaBuffer(att, deps.fetchImpl);
        } catch (err) {
          return {
            ok: false,
            detail: `media fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        const cap = MEDIA_SIZE_CAPS[att.kind];
        if (buffer.byteLength > cap) {
          return {
            ok: false,
            detail:
              `attachment exceeds size cap (${formatMb(buffer.byteLength)} > ` +
              `${formatMb(cap)} for ${att.kind})`,
          };
        }
        const supportsCaption =
          att.kind === 'image' || att.kind === 'video' || att.kind === 'file';
        const caption = !captionConsumed && supportsCaption ? body : undefined;
        if (caption !== undefined) captionConsumed = true;

        const media = deps.client.mediaFromBuffer({
          mimetype: att.mimeType,
          data: buffer,
          ...(att.filename ? { filename: att.filename } : {}),
        });
        const options = buildSendOptions(att, caption);
        const id = await deps.client.sendMedia(
          chatId,
          media,
          options,
          { kind: att.kind, bytes: buffer.byteLength },
        );
        if (id) lastMessageId = id;
      }
      if (!captionConsumed && body && body.length > 0) {
        const id = await deps.client.sendText(chatId, body);
        if (id) lastMessageId = id;
      }
    } else {
      const id = await deps.client.sendText(chatId, body);
      if (id) lastMessageId = id;
    }

    if (deps.onAfterSend) {
      try {
        await deps.onAfterSend(chatId);
      } catch {
        /* never fatal */
      }
    }
    return { ok: true, ...(lastMessageId ? { messageId: lastMessageId } : {}) };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Convert raw phone / JID / chatId input to a whatsapp-web.js `@c.us`
 * chat id (DM) or pass through group ids unchanged. Returns null when
 * the input can't sensibly be turned into one.
 *
 * Inputs accepted:
 *   60123456789                → 60123456789@c.us
 *   +60 123-456-789            → 60123456789@c.us
 *   60123456789@s.whatsapp.net → 60123456789@c.us  (rewrite baileys form)
 *   60123456789@c.us           → unchanged
 *   <abc>@lid                  → unchanged (Privacy id — webjs accepts)
 *   <group>-<ts>@g.us          → unchanged
 */
export function toChatId(to: string): string | null {
  const trimmed = to.trim();
  if (!trimmed) return null;
  if (trimmed.endsWith('@g.us')) return trimmed;
  if (trimmed.endsWith('@c.us')) return trimmed;
  if (trimmed.endsWith('@lid')) return trimmed;
  // Rewrite Baileys' @s.whatsapp.net → @c.us so an operator copy/pasting
  // a JID from another adapter still works.
  if (trimmed.endsWith('@s.whatsapp.net')) {
    const digits = trimmed.slice(0, -'@s.whatsapp.net'.length).replace(/\D/g, '');
    if (!digits) return null;
    return `${digits}@c.us`;
  }
  if (trimmed.includes('@')) {
    // Unknown suffix — pass through; webjs will reject if invalid.
    return trimmed;
  }
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  return `${digits}@c.us`;
}

export function isGroupChatId(chatId: string): boolean {
  return chatId.endsWith('@g.us');
}

export function validateAttachment(
  att: Attachment,
): { ok: true } | { ok: false; detail: string } {
  if (!att.mimeType || typeof att.mimeType !== 'string') {
    return { ok: false, detail: 'attachment.mimeType is required' };
  }
  const lc = att.mimeType.toLowerCase();
  switch (att.kind) {
    case 'image':
      if (!lc.startsWith('image/'))
        return { ok: false, detail: `image kind expects image/*, got ${att.mimeType}` };
      break;
    case 'video':
      if (!lc.startsWith('video/'))
        return { ok: false, detail: `video kind expects video/*, got ${att.mimeType}` };
      break;
    case 'audio':
      if (!lc.startsWith('audio/'))
        return { ok: false, detail: `audio kind expects audio/*, got ${att.mimeType}` };
      break;
    case 'file':
      break;
    default:
      return {
        ok: false,
        detail: `unsupported attachment kind: ${(att as { kind?: string }).kind ?? 'unset'}`,
      };
  }
  if (!att.data && !att.url) {
    return { ok: false, detail: 'attachment must supply either data or url' };
  }
  return { ok: true };
}

export function isVoiceMemo(mimeType: string): boolean {
  return mimeType.toLowerCase().includes('ogg') && mimeType.toLowerCase().includes('opus');
}

export async function resolveMediaBuffer(
  att: Attachment,
  fetchImpl?: OutboundDeps['fetchImpl'],
): Promise<Buffer> {
  if (att.data) {
    return Buffer.isBuffer(att.data) ? (att.data as Buffer) : Buffer.from(att.data);
  }
  if (!att.url) {
    throw new Error('attachment has neither data nor url');
  }
  const f =
    fetchImpl ??
    ((url: string) =>
      (globalThis.fetch as unknown as (u: string) => Promise<{
        ok: boolean;
        status: number;
        arrayBuffer(): Promise<ArrayBuffer>;
      }>)(url));
  const res = await f(att.url);
  if (!res.ok) {
    throw new Error(`fetch ${att.url} returned ${res.status}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Build whatsapp-web.js' send options (`{ caption, sendAudioAsVoice,
 * sendMediaAsDocument, ... }`). The media payload itself goes in as the
 * second arg to `client.sendMessage(chatId, media, options)`.
 */
export function buildSendOptions(
  att: Attachment,
  caption: string | undefined,
): Record<string, unknown> {
  const opts: Record<string, unknown> = {};
  if (caption) opts['caption'] = caption;
  switch (att.kind) {
    case 'image':
      // No-op — whatsapp-web.js detects image mime and renders inline.
      break;
    case 'video':
      // Same — auto-detected from mime.
      break;
    case 'audio':
      if (isVoiceMemo(att.mimeType)) {
        opts['sendAudioAsVoice'] = true;
      }
      break;
    case 'file':
      // Force document-bubble rendering even for image/* mimes (operators
      // who explicitly want a PDF / DOCX sent as a "file" attachment).
      opts['sendMediaAsDocument'] = true;
      break;
  }
  return opts;
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
