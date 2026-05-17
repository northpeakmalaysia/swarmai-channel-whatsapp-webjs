# SwarmAI Channel: WhatsApp Personal (Web.js)

SwarmAI channel plugin that connects to a personal WhatsApp account via [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) — a puppeteer-driven wrapper that drives the real WhatsApp Web UI in a headless Chrome process. Heavier than Baileys but media-reliable in daemon contexts (Windows services, NSSM, systemd).

## When to use this

- **You send a lot of documents / images / videos.** Web.js delegates upload to WhatsApp Web's own JS so the browser handles the awkward `mmg.whatsapp.net` upload path — no separate WebSocket-to-HTTPS bridge to hang in Session 0.
- **You have ~300 MB RAM to spare** for a persistent Chrome process.
- **You're running in a service / daemon context** where Baileys' media path stalls.

## When to use [Baileys plugin](https://github.com/northpeakmalaysia/swarmai-channel-whatsapp-baileys) instead

- **Most messages are text.** Cold-start in 1-3s, sub-second latency, ~50 MB RAM.
- **You can't spare a persistent Chrome process** (cheap VPS, embedded host, container with tight limits).
- **You want minimal install footprint.**

Both plugins can be installed simultaneously and paired to the **same WhatsApp account** (Multi-Device supports up to 4 linked devices). The Main Agent picks the right one per send: text → Baileys, media → Web.js.

## Installation

Via the SwarmAI Hub:

```bash
swarmai hub install channel-whatsapp-webjs
```

Or from the dashboard: **Hub → Channels → WhatsApp (Web.js) → Install**.

### Prerequisites

This plugin uses `puppeteer-core` (NOT `puppeteer`) — it does NOT bundle Chromium. You must have one of the following installed and discoverable:

- **Google Chrome** (Stable / Beta / Dev / Canary)
- **Microsoft Edge** (Chromium-based — default on Windows 10+)
- **Chromium**

The plugin reuses SwarmAI's existing Chrome detection (the same probe the PDF generator uses). If Chrome is missing, the plugin emits a clear startup error pointing to the install URL.

## Pairing

After install, pair via QR code:

1. Open **Channels** pane in the dashboard
2. Click **Pair** on the WhatsApp (Web.js) row
3. Scan the QR code from your phone's WhatsApp:
   - Phone: **Settings → Linked Devices → Link a Device**
   - Scan the QR code displayed in the dashboard
4. Wait for "Connected" status (10-30 seconds on first pair — Web.js has to boot Chrome)

Session credentials are stored at `<workspace>/.swarmai/webjs/profile/` (a persistent Chromium user-data-dir). They survive restarts — no re-pairing needed.

## Channel kind

This plugin registers channel kind **`whatsapp-webjs`** (NEW). The Baileys variant registers as **`whatsapp-personal`** (preserved for back-compat). Both can coexist; the bridge routes by channel id.

## Features

| Capability | Supported |
|---|---|
| Direct messages (1-to-1) | ✓ |
| Group messages | ✓ |
| Send images | ✓ (reliable, browser-handled upload) |
| Send videos | ✓ (reliable, browser-handled upload) |
| Send audio + voice memos | ✓ |
| Send documents (PDF up to 100 MB) | ✓ (the main reason this plugin exists) |
| Typing indicator | ✓ |
| Read receipts | ✓ |
| Reactions | ✓ |
| Voice/video calls | ✗ |
| Channels (broadcast) | ✗ |
| Status posts | ✗ |

## Known issues

- **Cold-start is slow.** First boot launches Chrome + downloads the WhatsApp Web JS bundle — expect 10-30s before pairing UI appears. Subsequent restarts are 3-5s.
- **NSSM / Session 0 needs the right Chrome flags.** This plugin applies `--headless` (legacy, NOT `--headless=new`), `--disable-gpu`, `--no-sandbox`, `--disable-crashpad`, `--disable-dev-shm-usage` so it runs cleanly under Windows services. Bundled Chrome from `puppeteer` would override these — that's why we use `puppeteer-core` + system Chrome.
- **Account ban risk is theoretically higher** than Baileys (WhatsApp's heuristics flag automation against the Web client). In practice, both plugins use the official Multi-Device pairing flow and have similar risk profiles for personal use.

## Development

```bash
npm install
npm run build
npm test
```

Tests use a fake whatsapp-web.js `Client` so the full puppeteer stack doesn't need to launch in CI.

## License

PolyForm Noncommercial 1.0.0 — see [LICENSE](./LICENSE).

For commercial use, contact [support@northpeak.app](mailto:support@northpeak.app).
