// esbuild bundle build for the Hub-distributed plugin.
//
// Why bundle (not plain tsc): @swarmai/shared, @swarmai/plugin-sdk and
// @swarmai/memory are INTERNAL workspace packages — not on npm — so a
// Hub install's `npm install` can never satisfy them. A plain tsc build
// leaves bare `import ... from '@swarmai/shared'` in dist, which fails
// at load with "Cannot find package '@swarmai/shared'". Bundling inlines
// those (+ zod) so the published dist is self-contained; only the heavy
// real npm deps (whatsapp-web.js, puppeteer-core, qrcode-terminal) stay
// external and are installed by the Hub.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = [...Object.keys(pkg.dependencies ?? {}), 'pino', 'pino-pretty'];

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/index.js',
  external,
  banner: {
    js: "import { createRequire as __swarmCreateRequire } from 'node:module';\nconst require = __swarmCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});

console.log('esbuild: bundled dist/index.js (self-contained — @swarmai/* + zod inlined)');
