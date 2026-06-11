#!/usr/bin/env node
/**
 * visual-debug — portable headless browser helper for screenshot + devtools
 * intel, designed to be invoked from Execute by any droid session in any
 * project, with zero MCP context cost.
 *
 * Usage:
 *   visual-debug <url> [options]
 *
 * Options:
 *   --out <path>          Output directory (default: ./.visual-debug)
 *   --name <basename>     Basename for outputs (default: timestamp)
 *   --viewport <WxH>      Viewport size (default: 1440x900)
 *   --device <name>       Use a Playwright device descriptor (e.g. "iPhone 14")
 *   --wait <selector>     Wait for selector before capture
 *   --wait-ms <n>         Extra wait in ms after load (default: 500)
 *   --full-page           Capture full page (default: viewport only)
 *   --dark                Use dark color scheme
 *   --no-screenshot       Skip the PNG
 *   --no-console          Skip console log capture
 *   --no-network          Skip network capture
 *   --no-dom              Skip DOM dump
 *   --no-a11y             Skip accessibility tree
 *   --no-perf             Skip performance metrics
 *   --script <path>       Run a JS file inside the page (post-load)
 *   --auth-storage <path> Load auth storageState JSON before navigation
 *   --user-agent <str>    Override user agent
 *   --executable <path>   Override chromium binary
 *   --slow                Add 250ms slowMo (useful when something flickers)
 *   --quiet               Only print the manifest JSON
 *
 * Outputs (under <out>/<name>.*):
 *   <name>.png             Screenshot
 *   <name>.dom.html        Outer HTML of <html>
 *   <name>.console.json    Console messages with type/text/location
 *   <name>.network.json    Network requests (url/status/method/type/size)
 *   <name>.a11y.json       Accessibility tree snapshot (Chromium devtools)
 *   <name>.perf.json       Performance metrics + paint timings
 *   <name>.manifest.json   Index of everything captured + summary
 *
 * Conventions:
 * - Headless Chromium from ~/.cache/ms-playwright/chromium-1217/ by default.
 *   Override with --executable or VISUAL_DEBUG_CHROMIUM env var.
 * - Forces QT_QPA_PLATFORM=xcb to work on Wayland desktops where the Qt
 *   wayland plugin is missing.
 * - Exit code 0 on success, non-zero on hard failure. Failed assets are
 *   skipped but never crash the whole run.
 */

import { chromium, devices } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ---- arg parsing (tiny, no dep) ----
const argv = process.argv.slice(2);
if (argv.length === 0 || ['-h', '--help'].includes(argv[0])) {
  // Print the doc comment above
  console.log(`visual-debug — usage:
  visual-debug <url> [options]

Options:
  --out <path>          Output directory (default: ./.visual-debug)
  --name <basename>     Basename for outputs (default: timestamp)
  --viewport <WxH>      Viewport size (default: 1440x900)
  --device <name>       Use a Playwright device descriptor (e.g. "iPhone 14")
  --wait <selector>     Wait for selector before capture
  --wait-ms <n>         Extra wait in ms after load (default: 500)
  --full-page           Capture full page
  --dark                Use dark color scheme
  --no-screenshot       Skip the PNG
  --no-console          Skip console log capture
  --no-network          Skip network capture
  --no-dom              Skip DOM dump
  --no-a11y             Skip accessibility tree
  --no-perf             Skip performance metrics
  --script <path>       Run a JS file inside the page
  --auth-storage <path> Load auth storageState JSON
  --user-agent <str>    Override user agent
  --executable <path>   Override chromium binary
  --slow                Add 250ms slowMo
  --quiet               Only print the manifest JSON

Example:
  visual-debug http://localhost:3000/app --full-page --wait "[data-cuotas-panel]"
`);
  process.exit(argv.length === 0 ? 1 : 0);
}

const url = argv[0];
const opts = {
  out: './.visual-debug',
  name: new Date().toISOString().replace(/[:.]/g, '-'),
  viewport: '1440x900',
  device: null,
  wait: null,
  waitMs: 500,
  fullPage: false,
  dark: false,
  screenshot: true,
  console: true,
  network: true,
  dom: true,
  a11y: true,
  perf: true,
  script: null,
  authStorage: null,
  userAgent: null,
  executable: process.env.VISUAL_DEBUG_CHROMIUM ||
    '/home/jcibernet/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',
  slow: false,
  quiet: false,
};

for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  switch (a) {
    case '--out': opts.out = next(); break;
    case '--name': opts.name = next(); break;
    case '--viewport': opts.viewport = next(); break;
    case '--device': opts.device = next(); break;
    case '--wait': opts.wait = next(); break;
    case '--wait-ms': opts.waitMs = parseInt(next(), 10); break;
    case '--full-page': opts.fullPage = true; break;
    case '--dark': opts.dark = true; break;
    case '--no-screenshot': opts.screenshot = false; break;
    case '--no-console': opts.console = false; break;
    case '--no-network': opts.network = false; break;
    case '--no-dom': opts.dom = false; break;
    case '--no-a11y': opts.a11y = false; break;
    case '--no-perf': opts.perf = false; break;
    case '--script': opts.script = next(); break;
    case '--auth-storage': opts.authStorage = next(); break;
    case '--user-agent': opts.userAgent = next(); break;
    case '--executable': opts.executable = next(); break;
    case '--slow': opts.slow = true; break;
    case '--quiet': opts.quiet = true; break;
    default:
      console.error(`Unknown option: ${a}`);
      process.exit(2);
  }
}

const log = (...a) => { if (!opts.quiet) console.error('[visual-debug]', ...a); };

const outDir = resolve(opts.out);
mkdirSync(outDir, { recursive: true });
const base = join(outDir, opts.name);
const paths = {
  screenshot: `${base}.png`,
  dom: `${base}.dom.html`,
  console: `${base}.console.json`,
  network: `${base}.network.json`,
  a11y: `${base}.a11y.json`,
  perf: `${base}.perf.json`,
  manifest: `${base}.manifest.json`,
};

if (!existsSync(opts.executable)) {
  console.error(
    `Chromium executable not found at ${opts.executable}.\n` +
    `Set VISUAL_DEBUG_CHROMIUM or pass --executable. ` +
    `If missing, run: npx playwright install chromium`,
  );
  process.exit(3);
}

// Force xcb on Wayland systems with broken Qt plugin
process.env.QT_QPA_PLATFORM = process.env.QT_QPA_PLATFORM || 'xcb';

const [vw, vh] = opts.viewport.split('x').map(n => parseInt(n, 10));

const browser = await chromium.launch({
  executablePath: opts.executable,
  headless: true,
  slowMo: opts.slow ? 250 : 0,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});

const contextOpts = {
  viewport: { width: vw, height: vh },
  colorScheme: opts.dark ? 'dark' : 'light',
};
if (opts.device && devices[opts.device]) Object.assign(contextOpts, devices[opts.device]);
if (opts.userAgent) contextOpts.userAgent = opts.userAgent;
if (opts.authStorage && existsSync(opts.authStorage)) contextOpts.storageState = opts.authStorage;

const context = await browser.newContext(contextOpts);
const page = await context.newPage();

// ---- collectors ----
const consoleMsgs = [];
if (opts.console) {
  page.on('console', msg => {
    consoleMsgs.push({
      type: msg.type(),
      text: msg.text(),
      location: msg.location(),
    });
  });
  page.on('pageerror', err => {
    consoleMsgs.push({ type: 'pageerror', text: err.message, stack: err.stack });
  });
}

const networkEvents = [];
if (opts.network) {
  page.on('response', async res => {
    try {
      const req = res.request();
      networkEvents.push({
        url: res.url(),
        method: req.method(),
        status: res.status(),
        type: req.resourceType(),
        contentType: res.headers()['content-type'] || null,
        fromCache: res.fromServiceWorker() ? 'sw' : null,
        timing: res.timing ? res.timing() : null,
      });
    } catch { /* noop */ }
  });
}

// ---- navigate ----
log(`navigating to ${url}`);
const navStart = Date.now();
let navError = null;
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
} catch (err) {
  navError = err.message;
  log(`nav warning: ${err.message}`);
}

if (opts.wait) {
  try { await page.waitForSelector(opts.wait, { timeout: 10000 }); }
  catch (err) { log(`wait selector "${opts.wait}" not found: ${err.message}`); }
}
if (opts.waitMs > 0) await page.waitForTimeout(opts.waitMs);

if (opts.script && existsSync(opts.script)) {
  const code = (await import('node:fs/promises')).then(fs => fs.readFile(opts.script, 'utf8'));
  try {
    await page.evaluate(await code);
  } catch (err) {
    log(`user script error: ${err.message}`);
  }
}

const navMs = Date.now() - navStart;

// ---- capture assets ----
const manifest = {
  url,
  finalUrl: page.url(),
  title: await page.title().catch(() => null),
  navError,
  navMs,
  viewport: { width: vw, height: vh },
  device: opts.device || null,
  colorScheme: opts.dark ? 'dark' : 'light',
  outputs: {},
  summary: {},
  generatedAt: new Date().toISOString(),
};

if (opts.screenshot) {
  try {
    await page.screenshot({ path: paths.screenshot, fullPage: opts.fullPage });
    manifest.outputs.screenshot = paths.screenshot;
  } catch (err) { log(`screenshot failed: ${err.message}`); }
}

if (opts.dom) {
  try {
    const html = await page.content();
    writeFileSync(paths.dom, html);
    manifest.outputs.dom = paths.dom;
  } catch (err) { log(`dom dump failed: ${err.message}`); }
}

if (opts.console) {
  writeFileSync(paths.console, JSON.stringify(consoleMsgs, null, 2));
  manifest.outputs.console = paths.console;
  manifest.summary.console = {
    total: consoleMsgs.length,
    errors: consoleMsgs.filter(m => m.type === 'error' || m.type === 'pageerror').length,
    warnings: consoleMsgs.filter(m => m.type === 'warning').length,
  };
}

if (opts.network) {
  writeFileSync(paths.network, JSON.stringify(networkEvents, null, 2));
  manifest.outputs.network = paths.network;
  manifest.summary.network = {
    total: networkEvents.length,
    failed: networkEvents.filter(r => r.status >= 400).length,
    byType: networkEvents.reduce((acc, r) => {
      acc[r.type] = (acc[r.type] || 0) + 1; return acc;
    }, {}),
  };
}

if (opts.a11y) {
  try {
    const snap = await page.accessibility.snapshot({ interestingOnly: true });
    writeFileSync(paths.a11y, JSON.stringify(snap, null, 2));
    manifest.outputs.a11y = paths.a11y;
  } catch (err) { log(`a11y snapshot failed: ${err.message}`); }
}

if (opts.perf) {
  try {
    const perf = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const paints = Object.fromEntries(
        performance.getEntriesByType('paint').map(p => [p.name, p.startTime]),
      );
      return {
        navigation: nav ? {
          domContentLoaded: nav.domContentLoadedEventEnd,
          load: nav.loadEventEnd,
          transferSize: nav.transferSize,
          encodedBodySize: nav.encodedBodySize,
          decodedBodySize: nav.decodedBodySize,
        } : null,
        paints,
        resourceCount: performance.getEntriesByType('resource').length,
        memory: performance.memory ? {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
        } : null,
      };
    });
    writeFileSync(paths.perf, JSON.stringify(perf, null, 2));
    manifest.outputs.perf = paths.perf;
    manifest.summary.perf = {
      load: perf.navigation?.load,
      fcp: perf.paints['first-contentful-paint'],
    };
  } catch (err) { log(`perf metrics failed: ${err.message}`); }
}

writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2));

await context.close();
await browser.close();

if (opts.quiet) {
  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
} else {
  console.log(JSON.stringify(manifest, null, 2));
}
