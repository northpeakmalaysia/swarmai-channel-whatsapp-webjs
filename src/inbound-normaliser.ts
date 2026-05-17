import type { Attachment, InboundEvent, SenderProfile } from '@swarmai/plugin-sdk';
import type { WebJsMessage } from './types.js';

/**
 * Normalise a whatsapp-web.js `Message` into the SDK's `InboundEvent`.
 *
 * Type mapping:
 *   'chat'                       → text body, no attachments
 *   'image'                      → image attachment + optional caption
 *   'video'                      → video attachment + optional caption
 *   'audio' / 'ptt'              → audio attachment (ptt = voice memo)
 *   'document'                   → file attachment with filename
 *   'sticker'                    → image attachment (kind=image)
 *   other (location, vcard, …)  → `[whatsapp-webjs:<type>]` placeholder
 *
 * Mention detection:
 *   `msg.mentionedIds` carries `<digits>@c.us` ids of mentioned contacts;
 *   if our own id matches, set `flags.mentioned = true`. Falls back to
 *   substring search on the body when the bot's display name is known.
 */

export interface NormaliseOptions {
  /** Bot's own chat id (`<digits>@c.us`). Used for mention detection. */
  selfChatId?: string;
  /** Bot's display name — matched against `@<name>` mentions in body. */
  selfDisplayName?: string;
}

export function normaliseWebJsMessage(
  channelId: string,
  msg: WebJsMessage,
  opts: NormaliseOptions = {},
): InboundEvent | null {
  if (!msg) return null;
  if (msg.id?.fromMe) return null;

  const from = msg.author ?? msg.from;
  if (!from) return null;

  const { body, attachments, decoded, type } = decodeContent(msg);
  const ts = (msg.timestamp ?? Math.floor(Date.now() / 1000)) * 1000;

  const isGroup = msg.isGroupMsg === true || msg.from?.endsWith('@g.us');
  const mentioned = detectMention(msg, body, opts);

  const flags: Record<string, boolean | string | number> = {
    chatType: isGroup ? 'group' : 'private',
  };
  if (isGroup) {
    flags['groupChat'] = true;
    if (msg.from) flags['groupId'] = msg.from;
  }
  if (mentioned) flags['mentioned'] = true;

  const profile = buildSenderProfile(msg);

  return {
    channelId,
    from,
    body: decoded ? body : body || `[whatsapp-webjs:${type}]`,
    ...(attachments.length ? { attachments } : {}),
    raw: msg,
    receivedAt: new Date(ts),
    ...(Object.keys(flags).length > 0 ? { flags } : {}),
    ...(profile ? { senderProfile: profile } : {}),
  };
}

interface DecodedContent {
  body: string;
  attachments: Attachment[];
  decoded: boolean;
  type: string;
}

function decodeContent(msg: WebJsMessage): DecodedContent {
  const type = msg.type ?? 'unknown';
  switch (type) {
    case 'chat':
      return { body: msg.body ?? '', attachments: [], decoded: true, type };
    case 'image':
      return {
        body: msg.caption ?? msg.body ?? '',
        attachments: [
          {
            kind: 'image',
            mimeType: msg.mimetype ?? 'image/jpeg',
          },
        ],
        decoded: true,
        type,
      };
    case 'video':
      return {
        body: msg.caption ?? msg.body ?? '',
        attachments: [
          {
            kind: 'video',
            mimeType: msg.mimetype ?? 'video/mp4',
          },
        ],
        decoded: true,
        type,
      };
    case 'audio':
    case 'ptt':
      return {
        body: '',
        attachments: [
          {
            kind: 'audio',
            mimeType: msg.mimetype ?? (type === 'ptt' ? 'audio/ogg; codecs=opus' : 'audio/mp4'),
          },
        ],
        decoded: true,
        type,
      };
    case 'document':
      return {
        body: msg.caption ?? msg.body ?? '',
        attachments: [
          {
            kind: 'file',
            mimeType: msg.mimetype ?? 'application/octet-stream',
            ...(msg.filename ? { filename: msg.filename } : {}),
          },
        ],
        decoded: true,
        type,
      };
    case 'sticker':
      return {
        body: '',
        attachments: [
          {
            kind: 'image',
            mimeType: msg.mimetype ?? 'image/webp',
          },
        ],
        decoded: true,
        type,
      };
    default:
      return { body: msg.body ?? '', attachments: [], decoded: false, type };
  }
}

function detectMention(
  msg: WebJsMessage,
  body: string,
  opts: NormaliseOptions,
): boolean {
  if (opts.selfChatId && Array.isArray(msg.mentionedIds)) {
    if (msg.mentionedIds.includes(opts.selfChatId)) return true;
  }
  if (opts.selfDisplayName && body) {
    const needle = `@${opts.selfDisplayName.trim().toLowerCase()}`;
    if (body.toLowerCase().includes(needle)) return true;
  }
  return false;
}

function buildSenderProfile(msg: WebJsMessage): SenderProfile | undefined {
  const profile: SenderProfile = {};
  const rawId = msg.author ?? msg.from;
  if (rawId) profile.rawId = rawId;
  if (msg.notifyName) profile.displayName = msg.notifyName;
  // `@c.us` ids carry the phone number as the local part.
  if (rawId && rawId.endsWith('@c.us')) {
    profile.phoneNumber = rawId.slice(0, -'@c.us'.length);
  }
  return Object.keys(profile).length > 0 ? profile : undefined;
}
