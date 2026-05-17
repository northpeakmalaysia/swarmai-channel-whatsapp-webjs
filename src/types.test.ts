import { describe, it, expect } from 'vitest';
import { WhatsAppWebJsConfigSchema, WhatsAppWebJsAuthSchema } from './types.js';

describe('WhatsAppWebJsConfigSchema', () => {
  it('applies sensible defaults on empty input', () => {
    const parsed = WhatsAppWebJsConfigSchema.parse({});
    expect(parsed.sessionId).toBe('default');
    expect(parsed.markRead).toBe(true);
    expect(parsed.typingIndicator).toBe(true);
    expect(parsed.respondToMentions).toBe(true);
    expect(parsed.headless).toBe(true);
    expect(parsed.reconnectBaseBackoffMs).toBe(2_000);
    expect(parsed.reconnectMaxBackoffMs).toBe(60_000);
    expect(parsed.reconnectMaxAttempts).toBe(5);
  });

  it('honours operator overrides', () => {
    const parsed = WhatsAppWebJsConfigSchema.parse({
      sessionId: '60123',
      typingIndicator: false,
      headless: false,
    });
    expect(parsed.sessionId).toBe('60123');
    expect(parsed.typingIndicator).toBe(false);
    expect(parsed.headless).toBe(false);
  });

  it('rejects zero / negative backoff values', () => {
    expect(() =>
      WhatsAppWebJsConfigSchema.parse({ reconnectBaseBackoffMs: 0 }),
    ).toThrow();
    expect(() =>
      WhatsAppWebJsConfigSchema.parse({ reconnectMaxBackoffMs: -1 }),
    ).toThrow();
  });
});

describe('WhatsAppWebJsAuthSchema', () => {
  it('accepts empty object', () => {
    expect(WhatsAppWebJsAuthSchema.parse({})).toEqual({});
  });
});
