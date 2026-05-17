import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Locate a Chrome / Chromium / Edge executable on the host.
 *
 * Mirrors the probe in `packages/tools/src/builtin/document.ts` so the
 * Web.js plugin reuses whatever Chrome SwarmAI already uses for PDF
 * generation — operators never have to install Chrome twice. Public
 * via `probeChromiumPath()`; returns null when nothing is found.
 *
 * Search order (most-trusted first):
 *   1. `$SWARMAI_CHROMIUM_PATH` env override (operator opt-in)
 *   2. `$PUPPETEER_EXECUTABLE_PATH` env (standard puppeteer override)
 *   3. Windows registry / PATH probes for chrome.exe, msedge.exe
 *   4. Linux/macOS `which` for google-chrome, chromium, chromium-browser
 *   5. Standard install paths per platform
 *
 * Sync because it runs at boot — no event loop yet. Cheap (no shell
 * spawn unless filesystem checks fail).
 */
export function probeChromiumPath(): string | null {
  const envOverride =
    process.env['SWARMAI_CHROMIUM_PATH'] ?? process.env['PUPPETEER_EXECUTABLE_PATH'];
  if (envOverride && existsSync(envOverride)) return envOverride;

  if (process.platform === 'win32') return probeWindows();
  if (process.platform === 'darwin') return probeMac();
  return probeLinux();
}

function probeWindows(): string | null {
  const programFiles = [
    process.env['PROGRAMFILES'] ?? 'C:\\Program Files',
    process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)',
    process.env['LOCALAPPDATA'] ?? join(process.env['USERPROFILE'] ?? '', 'AppData', 'Local'),
  ];
  const candidates = [
    'Google\\Chrome\\Application\\chrome.exe',
    'Microsoft\\Edge\\Application\\msedge.exe',
    'Chromium\\Application\\chrome.exe',
  ];
  for (const root of programFiles) {
    for (const tail of candidates) {
      const full = join(root, tail);
      if (existsSync(full)) return full;
    }
  }
  // Last resort: PATH probe via `where`.
  for (const exe of ['chrome.exe', 'msedge.exe']) {
    try {
      const result = execSync(`where ${exe}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const first = result.split(/\r?\n/)[0];
      if (first && existsSync(first)) return first;
    } catch {
      /* fall through */
    }
  }
  return null;
}

function probeMac(): string | null {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

function probeLinux(): string | null {
  const names = [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'microsoft-edge',
    'microsoft-edge-stable',
  ];
  for (const name of names) {
    try {
      const result = execSync(`which ${name}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (result && existsSync(result)) return result;
    } catch {
      /* fall through */
    }
  }
  // Standard install paths.
  const fallbacks = [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
  for (const path of fallbacks) {
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Chrome launch args optimised for Windows-service / NSSM Session-0
 * contexts where `--headless=new` and `--use-angle=default` silently
 * fail. Tested against Chrome 120+. Returns the array directly so
 * callers can spread it into puppeteer's `args` option.
 *
 * Key flags:
 *   --no-sandbox            Required when running as a service / root
 *   --disable-gpu           No GPU surface in Session 0
 *   --disable-crashpad      Stops crashpad from blocking startup on
 *                            services with no crash-reporter handle
 *   --disable-dev-shm-usage /dev/shm is tiny in containers; use /tmp
 *
 * The `headless: 'shell'` puppeteer option translates to `--headless`
 * (legacy). We DO NOT use `--headless=new` because it requires a
 * working compositor that's absent in Windows services.
 */
export const SESSION_0_SAFE_CHROME_ARGS = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-crashpad',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate,InterestFeedContentSuggestions,CrashpadReportUpload',
];
