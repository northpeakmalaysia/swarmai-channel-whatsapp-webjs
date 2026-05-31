export * from './types.js';
export * from './session-store.js';
export * from './chromium-probe.js';
export * from './qr-display.js';
export * from './webjs-client.js';
export * from './inbound-normaliser.js';
export * from './outbound-sender.js';
export * from './pair-flow.js';
// 2026-05-18 — UI-driven QR pair flow for the dashboard SSE router.
// Sibling to `runPairFlow` (CLI), exported via runWhatsAppWebJsPairForUi.
export * from './pair-ui.js';
export * from './plugin.js';
export * from './format.js';

// --- WhatsApp Personal slot ENGINE aliases (2026-05-31) ---
// The host's "WhatsApp Personal" slot loader + pair runners call a fixed
// set of names (`createWhatsAppPersonalPlugin`, the monitor-only bundle,
// `runWhatsAppPersonalPair[ForUi]`). Re-exporting the Web.js equivalents
// under those names makes Web.js a DROP-IN ENGINE for that slot — so when
// the server's HUB_INSTALL_ALIASES resolves `@swarmai/channel-whatsapp-
// personal` to this package (Baileys not installed), Web.js mounts as a
// live `whatsapp-personal` slot and the gateway's `whatsapp.*` capability
// tools route to it automatically (the resolver reads the personal-slot
// mount). Signatures mirror the Baileys plugin's by sibling design;
// smoke-test a fresh pair after deploy. EXISTING `whatsapp-webjs`
// pairings must re-pair under `whatsapp-personal` to mount via this path.
export {
  createWhatsAppWebJsPlugin as createWhatsAppPersonalPlugin,
  createWhatsAppWebJsMonitorOnlyBundle as createWhatsAppPersonalMonitorOnlyBundle,
} from './plugin.js';
export { runWhatsAppWebJsPairForUi as runWhatsAppPersonalPairForUi } from './pair-ui.js';
export { runPairFlow as runWhatsAppPersonalPair } from './pair-flow.js';
