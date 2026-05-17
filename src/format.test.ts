import { describe, it, expect } from 'vitest';
import { normaliseForWhatsApp } from './format.js';

describe('whatsapp-webjs/normaliseForWhatsApp', () => {
  it('rewrites [label](url) → "label (url)"', () => {
    expect(normaliseForWhatsApp('See [docs](https://example.com).')).toBe(
      'See docs (https://example.com).',
    );
  });

  it('strips ATX headings', () => {
    expect(normaliseForWhatsApp('## Sub\nbody')).toBe('Sub\nbody');
  });

  it('converts **bold** to *bold*', () => {
    expect(normaliseForWhatsApp('**important**')).toBe('*important*');
  });

  it('preserves WhatsApp-native *bold* / _italic_ / ~strike~', () => {
    const input = '*b* _i_ ~s~';
    expect(normaliseForWhatsApp(input)).toBe(input);
  });

  it('drops fenced-code language tags', () => {
    expect(normaliseForWhatsApp('```ts\nconst x = 1;\n```')).toBe(
      '```\nconst x = 1;\n```',
    );
  });

  it('returns empty unchanged', () => {
    expect(normaliseForWhatsApp('')).toBe('');
  });
});
