/**
 * Outbound text normalisation — strip markdown that WhatsApp Web doesn't
 * render natively so the agent's prose comes out clean on the phone.
 *
 * WhatsApp supports a tiny subset of markdown:
 *   *bold*       → bold
 *   _italic_     → italic
 *   ~strike~     → strikethrough
 *   ```monospace```
 *   > blockquote
 *
 * Anything else (#-headings, [label](url) links, [^footnotes], tables,
 * fenced code with language hints) renders verbatim — looking like raw
 * source on the operator's phone. We strip / rewrite the common
 * offenders here so the agent doesn't have to remember.
 *
 * Mirrors the Baileys adapter's normaliser so both plugins produce
 * identical outbound text for the same input.
 */
export function normaliseForWhatsApp(body: string): string {
  if (!body) return body;
  let out = body;

  // ATX headings: `# H1`, `## H2`, … → drop the leading hashes.
  out = out.replace(/^#{1,6}\s+/gm, '');

  // Inline links: `[label](url)` → "label (url)"
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // Reference-style images: `![alt](url)` → "alt (url)"
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)');

  // Convert standalone `**bold**` to WhatsApp's `*bold*` (single asterisk).
  out = out.replace(/\*\*([^*]+)\*\*/g, '*$1*');

  // Fenced code with language hint: drop the language token but keep the fence.
  out = out.replace(/```[a-zA-Z]+\n/g, '```\n');

  return out;
}
