import { describe, it, expect } from 'vitest';
import { normaliseWebJsMessage } from './inbound-normaliser.js';
import type { WebJsMessage } from './types.js';

function makeMsg(overrides: Partial<WebJsMessage> = {}): WebJsMessage {
  return {
    id: { id: 'abc', fromMe: false },
    from: '60123456789@c.us',
    body: 'hello',
    type: 'chat',
    timestamp: 1700000000,
    notifyName: 'Alice',
    ...overrides,
  };
}

describe('whatsapp-webjs/normaliseWebJsMessage', () => {
  it('returns null for messages from self', () => {
    const msg = makeMsg({ id: { id: 'abc', fromMe: true } });
    expect(normaliseWebJsMessage('whatsapp-webjs', msg)).toBeNull();
  });

  it('decodes a plain chat message', () => {
    const ev = normaliseWebJsMessage('whatsapp-webjs', makeMsg());
    expect(ev).not.toBeNull();
    expect(ev!.channelId).toBe('whatsapp-webjs');
    expect(ev!.from).toBe('60123456789@c.us');
    expect(ev!.body).toBe('hello');
    expect(ev!.attachments).toBeUndefined();
    expect(ev!.flags?.['chatType']).toBe('private');
  });

  it('surfaces senderProfile with phoneNumber for @c.us ids', () => {
    const ev = normaliseWebJsMessage('whatsapp-webjs', makeMsg());
    expect(ev!.senderProfile).toEqual({
      rawId: '60123456789@c.us',
      displayName: 'Alice',
      phoneNumber: '60123456789',
    });
  });

  it('decodes image with caption', () => {
    const ev = normaliseWebJsMessage(
      'whatsapp-webjs',
      makeMsg({
        type: 'image',
        caption: 'a pic',
        body: '',
        mimetype: 'image/jpeg',
      }),
    );
    expect(ev!.body).toBe('a pic');
    expect(ev!.attachments).toEqual([{ kind: 'image', mimeType: 'image/jpeg' }]);
  });

  it('decodes ptt voice memo as audio attachment', () => {
    const ev = normaliseWebJsMessage(
      'whatsapp-webjs',
      makeMsg({ type: 'ptt', body: '' }),
    );
    expect(ev!.attachments).toEqual([
      { kind: 'audio', mimeType: 'audio/ogg; codecs=opus' },
    ]);
  });

  it('decodes document with filename', () => {
    const ev = normaliseWebJsMessage(
      'whatsapp-webjs',
      makeMsg({
        type: 'document',
        body: '',
        caption: 'see file',
        mimetype: 'application/pdf',
        filename: 'invoice.pdf',
      }),
    );
    expect(ev!.body).toBe('see file');
    expect(ev!.attachments).toEqual([
      { kind: 'file', mimeType: 'application/pdf', filename: 'invoice.pdf' },
    ]);
  });

  it('flags group messages', () => {
    const ev = normaliseWebJsMessage(
      'whatsapp-webjs',
      makeMsg({
        isGroupMsg: true,
        from: '60123-1700@g.us',
        author: '60123456789@c.us',
      }),
    );
    expect(ev!.from).toBe('60123456789@c.us');
    expect(ev!.flags?.['groupChat']).toBe(true);
    expect(ev!.flags?.['groupId']).toBe('60123-1700@g.us');
  });

  it('detects @-mention via mentionedIds', () => {
    const ev = normaliseWebJsMessage(
      'whatsapp-webjs',
      makeMsg({
        body: '@bot hello',
        mentionedIds: ['60111111@c.us'],
      }),
      { selfChatId: '60111111@c.us' },
    );
    expect(ev!.flags?.['mentioned']).toBe(true);
  });

  it('detects mention via display-name fallback', () => {
    const ev = normaliseWebJsMessage(
      'whatsapp-webjs',
      makeMsg({ body: 'hey @Athena can you help?' }),
      { selfDisplayName: 'Athena' },
    );
    expect(ev!.flags?.['mentioned']).toBe(true);
  });

  it('falls back to placeholder for unknown message types', () => {
    const ev = normaliseWebJsMessage(
      'whatsapp-webjs',
      makeMsg({ type: 'location', body: '' }),
    );
    expect(ev!.body).toBe('[whatsapp-webjs:location]');
  });
});
