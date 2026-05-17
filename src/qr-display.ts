/**
 * QR display helper — renders a whatsapp-web.js QR string as ASCII
 * art on stderr.
 *
 * `qrcode-terminal` is a peer dep — lazy import on first use. Missing
 * dep falls back to printing the raw QR string with a note.
 */

export interface QrDisplayOptions {
  small?: boolean;
  stream?: NodeJS.WritableStream;
  onRender?: (qr: string, ascii?: string) => void;
}

export async function renderQr(qr: string, opts: QrDisplayOptions = {}): Promise<void> {
  const stream = opts.stream ?? process.stderr;
  const small = opts.small ?? true;

  let qrcodeTerminal: typeof import('qrcode-terminal') | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    qrcodeTerminal = (await import('qrcode-terminal')) as any;
  } catch {
    qrcodeTerminal = null;
  }

  if (!qrcodeTerminal) {
    const fallback =
      `[QR pairing — install qrcode-terminal to render ASCII art]\n` +
      `Raw QR: ${qr}\n` +
      `Or scan via https://qr-code-generator.com with this string.\n`;
    if (opts.onRender) opts.onRender(qr, fallback);
    else stream.write(fallback);
    return;
  }

  await new Promise<void>((resolve) => {
    qrcodeTerminal!.generate(qr, { small }, (ascii: string) => {
      if (opts.onRender) opts.onRender(qr, ascii);
      else stream.write(ascii + '\n');
      resolve();
    });
  });
}
