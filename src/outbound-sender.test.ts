import { describe, it, expect, vi } from 'vitest';
import {
  toChatId,
  isGroupChatId,
  validateAttachment,
  isVoiceMemo,
  buildSendOptions,
  sendOutbound,
  MEDIA_SIZE_CAPS,
} from './outbound-sender.js';
import type { OutboundEvent, Attachment } from '@swarmai/plugin-sdk';

describe('whatsapp-webjs/toChatId', () => {
  it('appends @c.us to bare digits', () => {
    expect(toChatId('60123456789')).toBe('60123456789@c.us');
  });

  it('strips non-digits from a formatted phone number', () => {
    expect(toChatId('+60 123-456-789')).toBe('60123456789@c.us');
  });

  it('rewrites baileys @s.whatsapp.net to @c.us', () => {
    expect(toChatId('60123456789@s.whatsapp.net')).toBe('60123456789@c.us');
  });

  it('passes @c.us through unchanged', () => {
    expect(toChatId('60123456789@c.us')).toBe('60123456789@c.us');
  });

  it('passes @g.us group ids through unchanged', () => {
    expect(toChatId('60123456789-1700000000@g.us')).toBe('60123456789-1700000000@g.us');
  });

  it('passes @lid (privacy ids) through unchanged', () => {
    expect(toChatId('abc123@lid')).toBe('abc123@lid');
  });

  it('returns null on empty input', () => {
    expect(toChatId('')).toBeNull();
    expect(toChatId('   ')).toBeNull();
  });

  it('returns null when nothing digit-like remains', () => {
    expect(toChatId('not-a-number')).toBeNull();
  });
});

describe('whatsapp-webjs/isGroupChatId', () => {
  it('detects @g.us as group', () => {
    expect(isGroupChatId('60-1700@g.us')).toBe(true);
  });
  it('rejects @c.us as non-group', () => {
    expect(isGroupChatId('60123@c.us')).toBe(false);
  });
});

describe('whatsapp-webjs/validateAttachment', () => {
  it('accepts image/jpeg with bytes', () => {
    const att: Attachment = {
      kind: 'image',
      mimeType: 'image/jpeg',
      data: new Uint8Array([0xff, 0xd8]),
    };
    expect(validateAttachment(att)).toEqual({ ok: true });
  });

  it('rejects image kind with non-image mime', () => {
    const att: Attachment = {
      kind: 'image',
      mimeType: 'application/pdf',
      data: new Uint8Array([0]),
    };
    expect(validateAttachment(att).ok).toBe(false);
  });

  it('accepts file kind with any mime', () => {
    const att: Attachment = {
      kind: 'file',
      mimeType: 'application/pdf',
      url: 'https://example.com/a.pdf',
    };
    expect(validateAttachment(att).ok).toBe(true);
  });

  it('rejects attachment with no data or url', () => {
    const att: Attachment = { kind: 'file', mimeType: 'application/pdf' };
    expect(validateAttachment(att).ok).toBe(false);
  });
});

describe('whatsapp-webjs/isVoiceMemo', () => {
  it('detects audio/ogg; codecs=opus', () => {
    expect(isVoiceMemo('audio/ogg; codecs=opus')).toBe(true);
  });
  it('rejects audio/mp4', () => {
    expect(isVoiceMemo('audio/mp4')).toBe(false);
  });
});

describe('whatsapp-webjs/buildSendOptions', () => {
  it('sets sendAudioAsVoice for ogg/opus', () => {
    const opts = buildSendOptions(
      { kind: 'audio', mimeType: 'audio/ogg; codecs=opus' } as Attachment,
      undefined,
    );
    expect(opts['sendAudioAsVoice']).toBe(true);
  });

  it('does not set sendAudioAsVoice for mp4', () => {
    const opts = buildSendOptions(
      { kind: 'audio', mimeType: 'audio/mp4' } as Attachment,
      undefined,
    );
    expect(opts['sendAudioAsVoice']).toBeUndefined();
  });

  it('forces document rendering for file kind', () => {
    const opts = buildSendOptions(
      { kind: 'file', mimeType: 'application/pdf' } as Attachment,
      'caption',
    );
    expect(opts['sendMediaAsDocument']).toBe(true);
    expect(opts['caption']).toBe('caption');
  });
});

describe('whatsapp-webjs/sendOutbound', () => {
  function makeFakeClient() {
    return {
      sendText: vi.fn().mockResolvedValue('msg-1'),
      sendMedia: vi.fn().mockResolvedValue('msg-2'),
      mediaFromBuffer: vi.fn().mockImplementation((args) => ({ _media: args })),
      mediaFromFilePath: vi.fn(),
      setTyping: vi.fn(),
    };
  }

  it('rejects channelId mismatch', async () => {
    const client = makeFakeClient();
    const event: OutboundEvent = {
      channelId: 'wrong',
      to: '60123456789',
      body: 'hi',
      format: 'plain',
    };
    const out = await sendOutbound(
      { client: client as never, channelId: 'whatsapp-webjs' },
      event,
    );
    expect(out.ok).toBe(false);
    expect(out.detail).toContain('channelId mismatch');
  });

  it('rejects empty body with no attachments', async () => {
    const client = makeFakeClient();
    const event: OutboundEvent = {
      channelId: 'whatsapp-webjs',
      to: '60123456789',
      body: '',
      format: 'plain',
    };
    const out = await sendOutbound(
      { client: client as never, channelId: 'whatsapp-webjs' },
      event,
    );
    expect(out.ok).toBe(false);
    expect(out.detail).toContain('empty body');
  });

  it('sends plain text via sendText', async () => {
    const client = makeFakeClient();
    const event: OutboundEvent = {
      channelId: 'whatsapp-webjs',
      to: '60123456789',
      body: 'hello',
      format: 'plain',
    };
    const out = await sendOutbound(
      { client: client as never, channelId: 'whatsapp-webjs' },
      event,
    );
    expect(out.ok).toBe(true);
    expect(client.sendText).toHaveBeenCalledWith('60123456789@c.us', 'hello');
    expect(client.sendMedia).not.toHaveBeenCalled();
  });

  it('sends image attachment with caption as media', async () => {
    const client = makeFakeClient();
    const event: OutboundEvent = {
      channelId: 'whatsapp-webjs',
      to: '60123456789',
      body: 'see this',
      format: 'plain',
      attachments: [
        {
          kind: 'image',
          mimeType: 'image/jpeg',
          data: new Uint8Array([0xff, 0xd8, 0xff]),
        },
      ],
    };
    const out = await sendOutbound(
      { client: client as never, channelId: 'whatsapp-webjs' },
      event,
    );
    expect(out.ok).toBe(true);
    expect(client.sendMedia).toHaveBeenCalledTimes(1);
    const [chatId, , opts] = client.sendMedia.mock.calls[0]!;
    expect(chatId).toBe('60123456789@c.us');
    expect((opts as { caption: string }).caption).toBe('see this');
    // Body was consumed by the caption — no trailing text send.
    expect(client.sendText).not.toHaveBeenCalled();
  });

  it('rejects oversize document', async () => {
    const client = makeFakeClient();
    const big = new Uint8Array(MEDIA_SIZE_CAPS.file + 1);
    const event: OutboundEvent = {
      channelId: 'whatsapp-webjs',
      to: '60123456789',
      body: 'doc',
      format: 'plain',
      attachments: [
        { kind: 'file', mimeType: 'application/pdf', data: big, filename: 'a.pdf' },
      ],
    };
    const out = await sendOutbound(
      { client: client as never, channelId: 'whatsapp-webjs' },
      event,
    );
    expect(out.ok).toBe(false);
    expect(out.detail).toContain('size cap');
  });
});
