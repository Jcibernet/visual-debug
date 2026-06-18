#!/usr/bin/env node
/**
 * visual-debug v0.4 — the agent's UI/UX inspector.
 *
 * Ephemeral by default. A run is a conversation with the page, not a permanent
 * artifact: it lives in a tmp dir and is deleted on exit. Persistence is opt-in
 * and semantic (--persist-as <name>), not timestamp accumulation.
 *
 * Signature output is a layout SVG (vector, not raster) + a uxReport of
 * geometry/accessibility heuristics, both derived from the page map. PNG/JPEG
 * screenshots are opt-in.
 *
 * Three modes (unchanged from v0.2):
 *   1) URL  : visual-debug <url> [opts]                  — one-shot snapshot.
 *   2) Flow : visual-debug --flow <file|->               — declarative multi-step.
 *   3) Diff : visual-debug --diff <baseline> <candidate> — compare two manifests.
 *
 * Plus a destructive management subcommand:
 *   4) Runs : visual-debug runs --list | --prune-stale | --prune-older-than | --clean
 *
 * Designed to be driven by AI agents (Claude Code, Droid, Cursor, etc.) with
 * zero MCP context cost. Every snapshot includes a "page map" listing every
 * interactable element with a stable ref, so the agent can navigate the page
 * by index without ever seeing the screen.
 *
 * See README for full docs.
 */

import { chromium, devices } from 'playwright';
import {
  mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync,
  readSync, rmSync, mkdtempSync,
} from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import readline from 'node:readline';

// ─────────────────────────────────────────────────────────────────────────────
// Ephemeral run-dir lifecycle
// ─────────────────────────────────────────────────────────────────────────────

let EPHEMERAL_DIR = null;
let CLEANED = false;
let WEBP_WARNED = false;

// Built-in device presets used by --device-matrix. Each maps to a viewport,
// pointer type and tap-target threshold so the uxReport adapts per form factor.
const DEVICE_PRESETS = {
  mobile:  { label: 'mobile',  viewport: [390, 844],  pointer: 'coarse', minTap: 44, playwright: 'iPhone 13' },
  tablet:  { label: 'tablet',  viewport: [820, 1180], pointer: 'coarse', minTap: 44, playwright: 'iPad (gen 7)' },
  desktop: { label: 'desktop', viewport: [1440, 900], pointer: 'fine',   minTap: 24, playwright: null },
};

function registerCleanup() {
  const cleanup = () => {
    if (CLEANED) return;
    CLEANED = true;
    if (EPHEMERAL_DIR) {
      try { rmSync(EPHEMERAL_DIR, { recursive: true, force: true }); } catch { /* noop */ }
    }
  };
  process.on('exit', cleanup);
  process.on('beforeExit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });
  process.on('uncaughtException', (err) => {
    cleanup();
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
registerCleanup();

// ─────────────────────────────────────────────────────────────────────────────
// CLI parsing
// ─────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

if (argv.length === 0 || ['-h', '--help'].includes(argv[0])) {
  printHelp();
  process.exit(argv.length === 0 ? 1 : 0);
}

// Dispatch
const mode = detectMode(argv);

if (mode === 'runs') {
  await runRunsMode(argv.slice(1));
} else if (mode === 'diff') {
  await runDiffMode(argv);
} else if (mode === 'flow') {
  await runFlowMode(argv);
} else {
  await runUrlMode(argv);
}

// ─────────────────────────────────────────────────────────────────────────────
// Mode: URL (v0.1/v0.2 compatible)
// ─────────────────────────────────────────────────────────────────────────────

async function runUrlMode(argv) {
  const url = argv[0];
  const opts = parseSharedOpts(argv.slice(1));

  if (!opts.executable) opts.executable = defaultChromium();
  if (!opts.executable || !existsSync(opts.executable)) chromiumNotFound(opts.executable);

  process.env.QT_QPA_PLATFORM = process.env.QT_QPA_PLATFORM || 'xcb';

  const outDir = resolveRunDir(opts);

  // --device-matrix runs the same URL across several form factors in one shot.
  const presets = opts.deviceMatrix; // array of preset names or null
  const profiles = presets
    ? presets.map(p => resolveProfile(opts, p))
    : [resolveProfile(opts, null)];

  const browser = await launchBrowser(opts);
  const perDevice = [];
  for (const profile of profiles) {
    const context = await newContext(browser, opts, profile);
    const page = await context.newPage();
    const collectors = attachCollectors(page, opts);
    const navMs = await navigate(page, url, opts);
    const snapName = presets ? `${opts.name}-${profile.label}` : opts.name;
    const m = await snapshot(page, {
      name: snapName,
      outDir,
      url,
      navMs,
      viewport: profile.viewport,
      device: profile.playwright || opts.device,
      profile,
      colorScheme: opts.dark ? 'dark' : 'light',
      collectors,
      captureFlags: opts.capture,
      fullPage: opts.fullPage,
      screenshotMode: opts.screenshotMode,
      screenshotFormat: opts.screenshotFormat,
    });
    await context.close();
    perDevice.push(m);
  }
  await browser.close();

  // Single profile → emit the snapshot manifest as before (back-compat).
  if (!presets) { emit(perDevice[0], opts); return; }

  // Matrix → emit a combined manifest with a cross-device UX comparison.
  const matrix = buildDeviceMatrixManifest(url, opts, perDevice, outDir);
  emit(matrix, opts);
}

// Combine per-device snapshots into one manifest, highlighting findings that
// appear on some devices but not others (the responsive-bug signal).
function buildDeviceMatrixManifest(url, opts, perDevice, outDir) {
  const byDevice = perDevice.map(m => ({
    device: m.profile?.label || m.name,
    name: m.name,
    manifestPath: m.manifestPath,
    layoutSvg: m.layoutSvg,
    viewport: m.viewport,
    uxFindings: m.summary?.uxFindings || {},
    errorFindings: countErrorFindings(m.uxReport),
  }));

  // Per-heuristic: which devices flagged it. A finding present on a subset is a
  // device-specific regression worth surfacing.
  const heuristics = new Set();
  for (const d of perDevice) for (const k of Object.keys(d.summary?.uxFindings || {})) heuristics.add(k);
  const crossDevice = {};
  for (const h of heuristics) {
    const on = perDevice.filter(d => (d.summary?.uxFindings?.[h] || 0) > 0).map(d => d.profile?.label || d.name);
    if (on.length > 0 && on.length < perDevice.length) crossDevice[h] = { flaggedOn: on, cleanOn: perDevice.filter(d => !on.includes(d.profile?.label || d.name)).map(d => d.profile?.label || d.name) };
  }

  const manifest = {
    type: 'device-matrix',
    url,
    devices: byDevice,
    deviceSpecificFindings: crossDevice,
    summary: {
      devices: byDevice.map(d => d.device),
      worstDevice: byDevice.slice().sort((a, b) => b.errorFindings - a.errorFindings)[0]?.device || null,
      deviceSpecificCount: Object.keys(crossDevice).length,
    },
    generatedAt: new Date().toISOString(),
  };
  const p = join(outDir, `${opts.name}.matrix.json`);
  writeFileSync(p, JSON.stringify(manifest, null, 2));
  manifest.manifestPath = p;
  return manifest;
}

function countErrorFindings(ux) {
  if (!ux) return 0;
  let n = 0;
  for (const [k, v] of Object.entries(ux)) {
    if (k === 'errors' || !Array.isArray(v)) continue;
    n += v.filter(f => f && f.severity === 'error').length;
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mode: Flow
// ─────────────────────────────────────────────────────────────────────────────

async function runFlowMode(argv) {
  const flowIdx = argv.indexOf('--flow');
  const flowSrc = argv[flowIdx + 1];
  if (!flowSrc) { console.error('--flow requires a path or "-"'); process.exit(2); }

  const flowJson = flowSrc === '-' ? readStdin() : readFileSync(resolve(flowSrc), 'utf8');
  let flow;
  try { flow = JSON.parse(flowJson); }
  catch (err) { console.error(`Invalid flow JSON: ${err.message}`); process.exit(2); }

  const opts = parseSharedOpts(argv.filter((_, i) => i !== flowIdx && i !== flowIdx + 1));
  // Flow-level overrides
  if (flow.viewport && !cliHas(argv, '--viewport')) opts.viewport = flow.viewport;
  if (flow.device && !cliHas(argv, '--device')) opts.device = flow.device;
  if (flow.dark != null) opts.dark = !!flow.dark;
  if (flow.name && !cliHas(argv, '--name')) opts.name = flow.name;

  if (!opts.executable) opts.executable = defaultChromium();
  if (!opts.executable || !existsSync(opts.executable)) chromiumNotFound(opts.executable);
  process.env.QT_QPA_PLATFORM = process.env.QT_QPA_PLATFORM || 'xcb';

  const outDir = resolveRunDir(opts);

  const browser = await launchBrowser(opts);
  const context = await newContext(browser, opts);
  const page = await context.newPage();
  const collectors = attachCollectors(page, opts);

  const timeline = [];
  const snapshots = [];
  let stepIdx = 0;
  let lastNavMs = 0;
  let aborted = null;

  for (const rawStep of flow.steps || []) {
    stepIdx++;
    const step = normalizeStep(rawStep);
    const t0 = Date.now();
    let entry = { idx: stepIdx, action: step.action, target: step.target, status: 'ok' };

    try {
      if (step.action === 'navigate') {
        const url = step.target.startsWith('http') ? step.target : (flow.baseUrl || '') + step.target;
        lastNavMs = await navigate(page, url, opts);
        entry.url = url;
        entry.navMs = lastNavMs;
      } else if (step.action === 'wait') {
        if (step.target) await page.waitForSelector(step.target, { timeout: step.timeout || 10000 });
        else if (step.ms) await page.waitForTimeout(step.ms);
        else await page.waitForLoadState('networkidle', { timeout: step.timeout || 15000 });
      } else if (step.action === 'click') {
        const el = await resolveTarget(page, step);
        await el.click({ button: step.button || 'left', timeout: 10000 });
      } else if (step.action === 'fill') {
        // fill supports either { target, value } or { fields: { selector: value } }
        if (step.fields) {
          for (const [sel, val] of Object.entries(step.fields)) {
            await page.fill(sel, String(val), { timeout: 10000 });
          }
        } else {
          const el = await resolveTarget(page, step);
          await el.fill(String(step.value), { timeout: 10000 });
        }
      } else if (step.action === 'type') {
        const el = await resolveTarget(page, step);
        // pressSequentially replaces the deprecated locator.type()
        await el.pressSequentially(String(step.value), { delay: step.delay || 0 });
      } else if (step.action === 'press') {
        await page.keyboard.press(step.key || step.value);
      } else if (step.action === 'select') {
        const el = await resolveTarget(page, step);
        await el.selectOption(step.value);
      } else if (step.action === 'hover') {
        const el = await resolveTarget(page, step);
        await el.hover();
      } else if (step.action === 'scroll') {
        if (step.target) {
          const el = await resolveTarget(page, step);
          await el.scrollIntoViewIfNeeded();
        } else {
          await page.evaluate((y) => window.scrollTo(0, y), step.y || 0);
        }
      } else if (step.action === 'eval') {
        if (opts.noEval) throw new Error('eval step disabled by --no-eval');
        entry.result = await page.evaluate(step.value);
      } else if (step.action === 'snapshot') {
        const snapName = step.name || `${opts.name}-step${stepIdx}`;
        const snap = await snapshot(page, {
          name: snapName,
          outDir,
          url: page.url(),
          navMs: lastNavMs,
          viewport: parseViewport(opts.viewport),
          device: opts.device,
          colorScheme: opts.dark ? 'dark' : 'light',
          collectors,
          captureFlags: opts.capture,
          fullPage: step.fullPage ?? opts.fullPage,
          screenshotMode: opts.screenshotMode,
          screenshotFormat: opts.screenshotFormat,
          stepScreenshot: step.screenshot === true,
        });
        snapshots.push(snap);
        entry.snapshot = snap.manifestPath;
        entry.layoutSvg = snap.layoutSvg;
      } else if (step.action === 'pause') {
        await page.waitForTimeout(step.ms || 500);
      } else {
        throw new Error(`Unknown action: ${step.action}`);
      }
    } catch (err) {
      entry.status = 'failed';
      entry.error = err.message;
      if (step.optional || flow.continueOnError) {
        entry.status = 'skipped';
      } else {
        aborted = { atStep: stepIdx, error: err.message };
      }
    }

    entry.ms = Date.now() - t0;
    timeline.push(entry);
    if (aborted) break;
  }

  // Always take a final snapshot unless flow says otherwise
  let finalSnap = null;
  if (flow.finalSnapshot !== false) {
    finalSnap = await snapshot(page, {
      name: `${opts.name}-final`,
      outDir,
      url: page.url(),
      navMs: lastNavMs,
      viewport: parseViewport(opts.viewport),
      device: opts.device,
      colorScheme: opts.dark ? 'dark' : 'light',
      collectors,
      captureFlags: opts.capture,
      fullPage: opts.fullPage,
      screenshotMode: opts.screenshotMode,
      screenshotFormat: opts.screenshotFormat,
    }).catch(() => null);
    if (finalSnap) snapshots.push(finalSnap);
  }

  await context.close();
  await browser.close();

  const flowManifest = {
    type: 'flow',
    name: opts.name,
    flowName: flow.name || opts.name,
    baseUrl: flow.baseUrl || null,
    aborted,
    steps: timeline,
    snapshots: snapshots.map(s => ({
      name: s.name,
      manifestPath: s.manifestPath,
      layoutSvg: s.layoutSvg,
      summary: s.summary,
    })),
    // The final snapshot is the canonical state for diffing. Promote its
    // layout + uxReport so the flow manifest is self-contained for --diff.
    layout: finalSnap?.layout ?? snapshots[snapshots.length - 1]?.layout ?? null,
    uxReport: finalSnap?.uxReport ?? snapshots[snapshots.length - 1]?.uxReport ?? null,
    outputs: finalSnap?.outputs ?? snapshots[snapshots.length - 1]?.outputs ?? {},
    summary: finalSnap?.summary ?? snapshots[snapshots.length - 1]?.summary ?? {},
    generatedAt: new Date().toISOString(),
  };
  const flowPath = join(outDir, `${opts.name}.flow.json`);
  writeFileSync(flowPath, JSON.stringify(flowManifest, null, 2));
  flowManifest.manifestPath = flowPath;

  emit(flowManifest, opts);
  process.exit(aborted ? 1 : 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Mode: Diff
// ─────────────────────────────────────────────────────────────────────────────

async function runDiffMode(argv) {
  let baselinePath, candidatePath, consumed;
  const da = argv.indexOf('--diff-against');
  if (da !== -1) {
    baselinePath = argv[da + 1];
    candidatePath = argv[da + 2] ?? '-';
    consumed = new Set([da, da + 1, da + 2]);
  } else {
    const i = argv.indexOf('--diff');
    baselinePath = argv[i + 1];
    candidatePath = argv[i + 2];
    consumed = new Set([i, i + 1, i + 2]);
  }
  if (!baselinePath || !candidatePath) {
    console.error('diff requires <baseline-manifest> <candidate-manifest> (use "-" for stdin)');
    process.exit(2);
  }

  const opts = parseSharedOpts(argv.filter((_, ix) => !consumed.has(ix)));
  const baseline = readManifestArg(baselinePath);
  const candidate = readManifestArg(candidatePath);

  const diff = computeDiff(baseline, candidate);

  // Diff output respects --emit-manifest semantics: persist only if requested.
  if (opts.persist || opts.persistAs || opts.outExplicit) {
    const outDir = resolveRunDir(opts);
    const diffPath = join(outDir, `${opts.name}.diff.json`);
    writeFileSync(diffPath, JSON.stringify(diff, null, 2));
    diff.manifestPath = diffPath;
  }

  emit(diff, opts);

  const failOn = (opts.failOn || 'console,network').split(',').map(s => s.trim());
  const shouldFail = failOn.some(k => diff.flags[k]);
  process.exit(shouldFail ? 1 : 0);
}

function readManifestArg(path) {
  const raw = path === '-' ? readStdin() : readFileSync(resolve(path), 'utf8');
  try { return JSON.parse(raw); }
  catch (err) { console.error(`Invalid manifest JSON (${path}): ${err.message}`); process.exit(2); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mode: Runs (destructive management — lives under a subcommand on purpose)
// ─────────────────────────────────────────────────────────────────────────────

async function runRunsMode(args) {
  const dir = resolve('./.visual-debug');
  const yes = args.includes('--yes');

  if (args.includes('--list')) {
    const runs = await inspectRuns(dir);
    console.log(JSON.stringify({ type: 'runs', dir, runs }, null, 2));
    process.exit(0);
  }

  if (args.includes('--clean')) {
    const runs = listRunDirs(dir);
    if (!runs.length) { console.error('No persisted runs.'); process.exit(0); }
    if (!(yes || await confirm(`Remove ALL ${runs.length} persisted runs in ${dir}? [y/N] `))) {
      console.error('Aborted.'); process.exit(1);
    }
    for (const r of runs) rmSync(r.path, { recursive: true, force: true });
    console.error(`Removed ${runs.length} run(s).`);
    process.exit(0);
  }

  if (args.includes('--prune-older-than')) {
    const dur = args[args.indexOf('--prune-older-than') + 1];
    const ms = parseDuration(dur);
    if (ms == null) { console.error(`Invalid duration: ${dur} (use e.g. 7d, 12h, 30m)`); process.exit(2); }
    const cutoff = Date.now() - ms;
    const victims = listRunDirs(dir).filter(r => r.mtimeMs < cutoff);
    if (!victims.length) { console.error('Nothing older than threshold.'); process.exit(0); }
    if (!(yes || await confirm(`Remove ${victims.length} run(s) older than ${dur}? [y/N] `))) {
      console.error('Aborted.'); process.exit(1);
    }
    for (const r of victims) rmSync(r.path, { recursive: true, force: true });
    console.error(`Removed ${victims.length} run(s) older than ${dur}: ${victims.map(v => v.name).join(', ')}`);
    process.exit(0);
  }

  if (args.includes('--prune-stale')) {
    const runs = await inspectRuns(dir);
    const stale = runs.filter(r => r.status === 'stale');
    if (!stale.length) { console.error('No stale runs found.'); process.exit(0); }
    if (!(yes || await confirm(`Remove ${stale.length} stale run(s)? [y/N] `))) {
      console.error('Aborted.'); process.exit(1);
    }
    for (const r of stale) rmSync(r.path, { recursive: true, force: true });
    console.error(`Removed ${stale.length} stale run(s): ${stale.map(s => s.name).join(', ')}`);
    process.exit(0);
  }

  console.error('runs requires one of: --list, --prune-stale, --prune-older-than <dur>, --clean');
  process.exit(2);
}

function listRunDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const path = join(dir, d.name);
      let mtimeMs = 0, size = 0;
      try {
        const st = statSync(path);
        mtimeMs = st.mtimeMs;
        size = dirSize(path);
      } catch { /* noop */ }
      return { name: d.name, path, mtimeMs, size };
    });
}

function dirSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSize(p);
      else total += statSync(p).size;
    } catch { /* noop */ }
  }
  return total;
}

function findPrimaryManifest(runPath) {
  let files;
  try { files = readdirSync(runPath); } catch { return null; }
  // Prefer a flow manifest, then a snapshot manifest.
  const flow = files.find(f => f.endsWith('.flow.json'));
  if (flow) return join(runPath, flow);
  const snap = files.find(f => f.endsWith('.manifest.json'));
  return snap ? join(runPath, snap) : null;
}

async function inspectRuns(dir) {
  const runs = listRunDirs(dir);
  const out = [];
  for (const r of runs) {
    const manifestPath = findPrimaryManifest(r.path);
    let url = null, status = 'unknown', baselineRefs = null;
    if (manifestPath) {
      try {
        const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
        url = m.url || m.finalUrl || null;
        baselineRefs = layoutSignature(m.layout) || actionsSignature(m.actions);
      } catch { /* noop */ }
    }
    if (url && baselineRefs) {
      status = await staleStatus(url, baselineRefs);
    }
    out.push({
      name: r.name,
      ageMs: Date.now() - r.mtimeMs,
      ageHuman: humanAge(Date.now() - r.mtimeMs),
      sizeBytes: r.size,
      url,
      status,
    });
  }
  return out;
}

function layoutSignature(layout) {
  if (!layout || !Array.isArray(layout.elements)) return null;
  return layout.elements.map(e => `${e.role}|${(e.name || '').slice(0, 40)}`);
}
function actionsSignature(actions) {
  if (!Array.isArray(actions)) return null;
  return actions.map(a => `${a.role}|${(a.name || '').slice(0, 40)}`);
}

// Re-snapshot the URL with the existing page-map collector and compare the
// top-level interactable signature. fresh | stale | unknown.
async function staleStatus(url, baselineRefs) {
  const executable = defaultChromium();
  if (!executable || !existsSync(executable)) return 'unknown';
  process.env.QT_QPA_PLATFORM = process.env.QT_QPA_PLATFORM || 'xcb';
  let browser;
  try {
    const dec = sandboxDecision({});
    browser = await chromium.launch({
      executablePath: executable, headless: true,
      args: launchArgs(dec.sandbox),
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    const map = await extractPageMap(page);
    await browser.close();
    const current = map.interactables.map(i => `${i.role}|${(i.name || '').slice(0, 40)}`);
    return signaturesMatch(baselineRefs, current) ? 'fresh' : 'stale';
  } catch {
    try { if (browser) await browser.close(); } catch { /* noop */ }
    return 'unknown';
  }
}

function signaturesMatch(a, b) {
  if (!a || !b) return false;
  // Structural match: same count within tolerance and ≥80% overlap of signatures.
  const setB = new Set(b);
  const overlap = a.filter(x => setB.has(x)).length;
  const denom = Math.max(a.length, b.length) || 1;
  return overlap / denom >= 0.8 && Math.abs(a.length - b.length) <= Math.ceil(denom * 0.2);
}

function parseDuration(s) {
  if (!s) return null;
  const m = /^(\d+)\s*([dhm])$/.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return { d: 86400000, h: 3600000, m: 60000 }[m[2]] * n;
}
function humanAge(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function confirm(question) {
  if (!process.stdin.isTTY) {
    console.error('Refusing destructive op without a TTY. Pass --yes to confirm.');
    return Promise.resolve(false);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(res => rl.question(question, ans => {
    rl.close();
    res(/^y(es)?$/i.test(ans.trim()));
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot pipeline (shared by URL + Flow)
// ─────────────────────────────────────────────────────────────────────────────

async function snapshot(page, ctx) {
  const base = join(ctx.outDir, ctx.name);
  const fmt = ctx.screenshotFormat || 'webp';
  const shot = screenshotPlan(fmt);
  const paths = {
    screenshot: `${base}.${shot.ext}`,
    dom: `${base}.dom.html`,
    console: `${base}.console.json`,
    network: `${base}.network.json`,
    a11y: `${base}.a11y.json`,
    perf: `${base}.perf.json`,
    pageMap: `${base}.map.json`,
    layoutSvg: `${base}.layout.svg`,
    manifest: `${base}.manifest.json`,
  };
  const viewport = ctx.viewport;
  const manifest = {
    type: 'snapshot',
    name: ctx.name,
    url: ctx.url,
    finalUrl: page.url(),
    title: await page.title().catch(() => null),
    navMs: ctx.navMs,
    viewport,
    device: ctx.device,
    profile: ctx.profile ? { label: ctx.profile.label, pointer: ctx.profile.pointer, minTap: ctx.profile.minTap } : null,
    colorScheme: ctx.colorScheme,
    outputs: {},
    summary: {},
    generatedAt: new Date().toISOString(),
  };

  const cap = ctx.captureFlags;

  if (cap.dom) {
    try {
      writeFileSync(paths.dom, await page.content());
      manifest.outputs.dom = paths.dom;
    } catch (err) { manifest.summary.domError = err.message; }
  }
  if (cap.console) {
    const msgs = ctx.collectors.flushConsole();
    writeFileSync(paths.console, JSON.stringify(msgs, null, 2));
    manifest.outputs.console = paths.console;
    manifest.summary.console = {
      total: msgs.length,
      errors: msgs.filter(m => m.type === 'error' || m.type === 'pageerror').length,
      warnings: msgs.filter(m => m.type === 'warning').length,
    };
  }
  if (cap.network) {
    const reqs = ctx.collectors.flushNetwork();
    writeFileSync(paths.network, JSON.stringify(reqs, null, 2));
    manifest.outputs.network = paths.network;
    manifest.summary.network = {
      total: reqs.length,
      failed: reqs.filter(r => r.status >= 400).length,
      byType: reqs.reduce((acc, r) => { acc[r.type] = (acc[r.type] || 0) + 1; return acc; }, {}),
    };
  }
  if (cap.a11y) {
    try {
      let snap = null;
      if (page.accessibility && typeof page.accessibility.snapshot === 'function') {
        snap = await page.accessibility.snapshot({ interestingOnly: true });
      } else {
        snap = await page.evaluate(() => {
          const walk = (el) => {
            if (!el || el.nodeType !== 1) return null;
            const role = el.getAttribute('role') || el.tagName.toLowerCase();
            const name = (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || (el.tagName === 'INPUT' ? el.placeholder : '') || el.textContent || '').trim().slice(0, 80);
            const children = Array.from(el.children).map(walk).filter(Boolean);
            return { role, name, children: children.length ? children : undefined };
          };
          return walk(document.body);
        });
      }
      writeFileSync(paths.a11y, JSON.stringify(snap, null, 2));
      manifest.outputs.a11y = paths.a11y;
    } catch (err) { manifest.summary.a11yError = err.message; }
  }
  if (cap.perf) {
    try {
      const perf = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0];
        const paints = Object.fromEntries(performance.getEntriesByType('paint').map(p => [p.name, p.startTime]));
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
      manifest.summary.perf = { load: perf.navigation?.load, fcp: perf.paints['first-contentful-paint'] };
    } catch (err) { manifest.summary.perfError = err.message; }
  }

  // ── Page map + uxReport (single browser walk) ────────────────────────────
  let map = null;
  let ux = null;
  if (cap.pageMap) {
    try {
      const state = await extractPageState(page, ctx.profile);
      map = state.map;
      ux = state.ux;
      writeFileSync(paths.pageMap, JSON.stringify(map, null, 2));
      manifest.outputs.pageMap = paths.pageMap;
      manifest.summary.pageMap = {
        interactables: map.interactables.length,
        forms: map.forms.length,
        landmarks: map.landmarks.length,
      };
      // Embed a compact preview directly in the manifest so the agent can
      // decide next step from manifest alone, without opening the map file.
      manifest.actions = map.interactables.slice(0, 50).map(i => ({
        ref: i.ref, role: i.role, name: i.name, selector: i.selector,
      }));
      // Self-contained geometry for layout diffing (all interactables).
      manifest.layout = {
        viewport: { width: viewport[0], height: viewport[1] },
        elements: map.interactables.map(i => ({ ref: i.ref, role: i.role, name: i.name, bbox: i.bbox })),
        landmarks: map.landmarks.filter(l => l.bbox).map(l => ({ role: l.role, bbox: l.bbox })),
      };
    } catch (err) { manifest.summary.pageMapError = err.message; }
  }

  // uxReport (heuristics) — never fails the run
  if (ux) {
    manifest.uxReport = ux;
    manifest.summary.uxFindings = countUxFindings(ux);
  }

  // ── Layout SVG (pure data → vector, no rasterization) ─────────────────────
  if (map) {
    try {
      const svg = renderLayoutSvg(map, ux, { width: viewport[0], height: viewport[1], url: manifest.finalUrl });
      writeFileSync(paths.layoutSvg, svg);
      manifest.outputs.layoutSvg = paths.layoutSvg;
      manifest.layoutSvg = paths.layoutSvg;
    } catch (err) { manifest.summary.layoutSvgError = err.message; }
  }

  // ── Screenshot (opt-in) ───────────────────────────────────────────────────
  const wantShot =
    ctx.stepScreenshot === true ||
    ctx.screenshotMode === 'all' ||
    (ctx.screenshotMode === 'on-issue' && hasErrorFinding(ux));
  if (wantShot) {
    try {
      if (shot.webpFallback && !WEBP_WARNED) {
        console.error('note: Playwright cannot emit webp; using jpeg q70 instead.');
        WEBP_WARNED = true;
      }
      await page.screenshot({ path: paths.screenshot, fullPage: ctx.fullPage, ...shot.pwOpts });
      manifest.outputs.screenshot = paths.screenshot;
      manifest.screenshot = paths.screenshot;
    } catch (err) { manifest.summary.screenshotError = err.message; }
  }

  writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2));
  manifest.manifestPath = paths.manifest;
  return manifest;
}

// Playwright 1.x screenshot only supports png|jpeg. webp falls back to jpeg.
function screenshotPlan(format) {
  if (format === 'png') return { ext: 'png', pwOpts: { type: 'png' }, webpFallback: false };
  if (format === 'jpeg' || format === 'jpg') return { ext: 'jpg', pwOpts: { type: 'jpeg', quality: 70 }, webpFallback: false };
  // webp (default): Playwright cannot emit webp, use jpeg q70.
  return { ext: 'jpg', pwOpts: { type: 'jpeg', quality: 70 }, webpFallback: true };
}

function hasErrorFinding(ux) {
  if (!ux) return false;
  for (const v of Object.values(ux)) {
    if (Array.isArray(v) && v.some(f => f && f.severity === 'error')) return true;
  }
  return false;
}
function countUxFindings(ux) {
  const out = {};
  for (const [k, v] of Object.entries(ux)) {
    if (Array.isArray(v) && k !== 'errors') out[k] = v.length;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout SVG — pure function (data → string, no DOM / no Playwright)
// ─────────────────────────────────────────────────────────────────────────────

export function renderLayoutSvg(pageMap, uxReport, viewport) {
  const W = viewport.width || 1440;
  const H = viewport.height || 900;
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Map ref → { codes:[], severity } from all uxReport finding arrays.
  const issuesByRef = new Map();
  let maxSev = (a, b) => (sevRank(b) > sevRank(a) ? b : a);
  if (uxReport) {
    for (const [code, v] of Object.entries(uxReport)) {
      if (!Array.isArray(v) || code === 'errors') continue;
      for (const f of v) {
        if (f && f.ref != null) {
          const cur = issuesByRef.get(f.ref) || { codes: [], severity: 'info' };
          cur.codes.push(f.code || code);
          cur.severity = maxSev(cur.severity, f.severity || 'warn');
          issuesByRef.set(f.ref, cur);
        }
      }
    }
  }

  const COLORS = {
    button: '#2e7d32',
    link: '#6a1b9a',
    input: '#1565c0',
    select: '#1565c0',
    textarea: '#1565c0',
    other: '#546e7a',
  };
  const roleFamily = (role) => {
    if (!role) return 'other';
    if (role === 'button') return 'button';
    if (role === 'link') return 'link';
    if (role.startsWith('input')) return 'input';
    if (role === 'select') return 'select';
    if (role === 'textarea') return 'textarea';
    return 'other';
  };

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="monospace">`);
  parts.push(`<title>${esc(viewport.url || '')} — ${W}x${H}</title>`);
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#fafafa" stroke="#e0e0e0"/>`);

  // Background layer: landmarks as light filled regions.
  for (const lm of (pageMap.landmarks || [])) {
    if (!lm.bbox) continue;
    const { x, y, w, h } = lm.bbox;
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#eef3f8" stroke="#cdd8e3" stroke-dasharray="2 2" data-landmark="${esc(lm.role)}"/>`);
    parts.push(`<text x="${x + 4}" y="${y + 12}" font-size="9" fill="#90a4ae">${esc(lm.role)}</text>`);
  }

  // Headings as outline rects with a small label.
  for (const hd of (pageMap.headings || [])) {
    if (!hd.bbox) continue;
    const { x, y, w, h } = hd.bbox;
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#b0bec5" stroke-width="1" data-heading="h${hd.level}"/>`);
    if (w >= 30 && h >= 12) {
      parts.push(`<text x="${x + 2}" y="${y + 11}" font-size="9" fill="#78909c">h${hd.level} ${esc(trunc(hd.text, 24))}</text>`);
    }
  }

  // Foreground: interactables.
  for (const el of (pageMap.interactables || [])) {
    const b = el.bbox;
    if (!b) continue;
    const fam = roleFamily(el.role);
    const color = COLORS[fam] || COLORS.other;
    const issue = issuesByRef.get(el.ref);
    const stroke = issue ? '#d32f2f' : color;
    const dash = issue ? ' stroke-dasharray="4 2"' : '';
    const issueAttr = issue ? ` data-issue="${esc(issue.codes.join(','))}"` : '';
    parts.push(
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="${color}" fill-opacity="0.10" ` +
      `stroke="${stroke}" stroke-width="${issue ? 2 : 1}"${dash} ` +
      `data-ref="${el.ref}" data-role="${esc(el.role)}" data-name="${esc(trunc(el.name, 60))}"${issueAttr}/>`
    );
    // Labels: skip clutter on tiny elements.
    if (b.w >= 30 && b.h >= 15) {
      const label = `${el.ref} ${trunc(el.name, 18)}`.trim();
      const ty = b.y + 11 <= H ? b.y + 11 : b.y - 2;
      parts.push(`<text x="${b.x + 3}" y="${ty}" font-size="10" fill="${stroke}">${esc(label)}</text>`);
    }
  }

  parts.push('</svg>');
  return parts.join('\n');
}

function sevRank(s) { return { info: 0, warn: 1, error: 2 }[s] ?? 0; }
function trunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ─────────────────────────────────────────────────────────────────────────────
// Page map + uxReport — single browser walk
// ─────────────────────────────────────────────────────────────────────────────

async function extractPageState(page, profile = { pointer: 'fine', minTap: 24, label: 'desktop' }) {
  return await page.evaluate((profile) => {
    // ── shared helpers (browser context) ──
    const stableSelector = (el) => {
      if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;
      for (const attr of ['data-testid', 'data-test', 'data-cy', 'data-qa', 'data-action', 'name']) {
        const v = el.getAttribute?.(attr);
        if (v) return `[${attr}="${CSS.escape(v)}"]`;
      }
      const tag = el.tagName.toLowerCase();
      const aria = el.getAttribute?.('aria-label');
      if (aria) return `${tag}[aria-label="${CSS.escape(aria)}"]`;
      let cur = el, parts = [];
      while (cur && cur.nodeType === 1 && parts.length < 4) {
        const p = cur.parentElement;
        if (!p) { parts.unshift(cur.tagName.toLowerCase()); break; }
        const same = Array.from(p.children).filter(c => c.tagName === cur.tagName);
        const idx = same.indexOf(cur) + 1;
        parts.unshift(`${cur.tagName.toLowerCase()}:nth-of-type(${idx})`);
        cur = p;
      }
      return parts.join(' > ');
    };
    const accessibleName = (el) => {
      const label = el.getAttribute?.('aria-label')
        || el.getAttribute?.('alt')
        || el.getAttribute?.('title')
        || el.getAttribute?.('placeholder')
        || (el.labels && el.labels[0]?.textContent)
        || el.textContent;
      return (label || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    };
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      return true;
    };
    const role = (el) => {
      const r = el.getAttribute?.('role');
      if (r) return r;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a' && el.href) return 'link';
      if (tag === 'button' || (tag === 'input' && ['button','submit','reset'].includes(el.type))) return 'button';
      if (tag === 'input') return `input:${el.type || 'text'}`;
      if (tag === 'textarea') return 'textarea';
      if (tag === 'select') return 'select';
      if (tag === 'summary') return 'summary';
      if (el.hasAttribute?.('onclick') || el.hasAttribute?.('tabindex')) return 'interactive';
      return tag;
    };
    const bboxOf = (el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };

    // ── page map ──
    const result = { interactables: [], forms: [], landmarks: [], scrollable: [], headings: [] };
    let counter = 0;

    const interactiveSel = [
      'a[href]', 'button', 'input', 'textarea', 'select', 'summary', 'label',
      '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
      '[role="tab"]', '[role="menuitem"]', '[role="switch"]', '[role="option"]',
      '[onclick]', '[tabindex]:not([tabindex="-1"])',
    ].join(',');

    const interactiveEls = []; // parallel array holding live element refs
    document.querySelectorAll(interactiveSel).forEach(el => {
      if (!isVisible(el)) return;
      const rec = {
        ref: ++counter,
        role: role(el),
        name: accessibleName(el),
        selector: stableSelector(el),
        value: el.value ?? null,
        checked: el.checked ?? null,
        disabled: el.disabled ?? null,
        bbox: bboxOf(el),
      };
      result.interactables.push(rec);
      interactiveEls.push({ ...rec, el });
    });

    document.querySelectorAll('form').forEach(form => {
      const fields = Array.from(form.querySelectorAll('input,textarea,select')).map(f => ({
        name: f.name || null,
        type: f.type || f.tagName.toLowerCase(),
        required: f.required,
        value: f.value,
      }));
      result.forms.push({
        selector: stableSelector(form),
        action: form.action || null,
        method: form.method || 'get',
        fields,
      });
    });

    document.querySelectorAll('main,nav,header,footer,aside,[role="main"],[role="navigation"],[role="banner"],[role="complementary"],[role="contentinfo"]').forEach(el => {
      if (!isVisible(el)) return;
      result.landmarks.push({ role: role(el), selector: stableSelector(el), name: accessibleName(el), bbox: bboxOf(el) });
    });

    document.querySelectorAll('h1,h2,h3').forEach(h => {
      if (!isVisible(h)) return;
      result.headings.push({ level: parseInt(h.tagName[1], 10), text: (h.textContent || '').trim().slice(0, 120), selector: stableSelector(h), bbox: bboxOf(h) });
    });

    // ── uxReport heuristics ──
    const ux = { errors: [] };
    const vw = window.innerWidth, vh = window.innerHeight;
    ux.viewport = { width: vw, height: vh, devicePixelRatio: window.devicePixelRatio || 1 };

    const push = (arr, o) => arr.push(o);
    const F = (name) => (ux[name] = ux[name] || []);

    // contrast helpers (WCAG)
    const parseColor = (str) => {
      if (!str) return null;
      const m = /rgba?\(([^)]+)\)/.exec(str);
      if (!m) return null;
      const p = m[1].split(',').map(s => parseFloat(s.trim()));
      const a = p.length > 3 ? p[3] : 1;
      return { r: p[0], g: p[1], b: p[2], a };
    };
    const relLum = ({ r, g, b }) => {
      const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const contrastRatio = (c1, c2) => {
      const l1 = relLum(c1), l2 = relLum(c2);
      const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
      return (hi + 0.05) / (lo + 0.05);
    };
    const effectiveBg = (el) => {
      let cur = el;
      while (cur && cur.nodeType === 1) {
        const c = parseColor(getComputedStyle(cur).backgroundColor);
        if (c && c.a > 0) return c;
        cur = cur.parentElement;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };

    // Device-aware thresholds: touch needs 44px tap targets (WCAG 2.5.5) and
    // horizontal overflow is a hard break; fine pointers tolerate 24px and an
    // overflow-x is a softer warning.
    const isTouch = profile.pointer === 'coarse';
    const minTap = profile.minTap || (isTouch ? 44 : 24);

    try {
      // geometry: overflow on document root
      const de = document.documentElement;
      const overflow = F('overflow');
      if (de.scrollWidth > de.clientWidth + 1) push(overflow, { selector: 'html', code: 'overflow-x', message: `scrollWidth ${de.scrollWidth} > clientWidth ${de.clientWidth}`, severity: isTouch ? 'error' : 'warn' });
      if (de.scrollHeight > de.clientHeight + 1) push(overflow, { selector: 'html', code: 'overflow-y', message: `scrollHeight ${de.scrollHeight} > clientHeight ${de.clientHeight}`, severity: 'info' });
    } catch (e) { ux.errors.push({ collector: 'overflow', message: e.message }); }

    try {
      const offscreen = F('offscreen');
      const tiny = F('tinyTapTargets');
      for (const rec of interactiveEls) {
        const b = rec.bbox;
        if (b.x + b.w < 0 || b.y + b.h < 0 || b.x > vw || b.y > vh) {
          push(offscreen, { ref: rec.ref, selector: rec.selector, code: 'offscreen', message: `outside viewport (${b.x},${b.y})`, severity: 'warn' });
        }
        if ((b.w < minTap || b.h < minTap) && b.w > 0 && b.h > 0) {
          push(tiny, { ref: rec.ref, selector: rec.selector, code: 'tiny-tap-target', message: `${b.w}x${b.h} < ${minTap}x${minTap} (${profile.label})`, severity: isTouch ? 'error' : 'warn', width: b.w, height: b.h });
        }
      }
    } catch (e) { ux.errors.push({ collector: 'geometry', message: e.message }); }

    // touch-only inaccessibility: hover-revealed interactables on a touch device.
    try {
      if (isTouch) {
        const hoverOnly = F('hoverOnlyOnTouch');
        for (const rec of interactiveEls) {
          const el = rec.el;
          if (!el) continue;
          // crude heuristic: element relies on :hover to become usable if a
          // parent has a hover handler and the element is initially clipped.
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.opacity === '0') {
            push(hoverOnly, { ref: rec.ref, selector: rec.selector, code: 'hover-only-touch', message: 'interactable hidden until hover (no touch equivalent)', severity: 'warn' });
          }
        }
      }
    } catch (e) { ux.errors.push({ collector: 'hoverOnlyOnTouch', message: e.message }); }

    try {
      const overlaps = F('overlaps');
      const n = Math.min(interactiveEls.length, 250);
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = interactiveEls[i].bbox, b = interactiveEls[j].bbox;
          const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
          const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
          const inter = ix * iy;
          if (inter <= 0) continue;
          const minArea = Math.min(a.w * a.h, b.w * b.h) || 1;
          if (inter / minArea > 0.5) {
            push(overlaps, { ref: interactiveEls[i].ref, selector: interactiveEls[i].selector, code: 'overlap', message: `overlaps ref ${interactiveEls[j].ref} (${Math.round(inter / minArea * 100)}%)`, severity: 'info' });
          }
        }
      }
    } catch (e) { ux.errors.push({ collector: 'overlaps', message: e.message }); }

    try {
      const truncated = F('truncatedText');
      for (const rec of interactiveEls) {
        const el = rec.el;
        const cs = getComputedStyle(el);
        if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) {
          push(truncated, { ref: rec.ref, selector: rec.selector, code: 'truncated-text', message: `text clipped (${el.scrollWidth}>${el.clientWidth})`, severity: 'info' });
        }
      }
    } catch (e) { ux.errors.push({ collector: 'truncatedText', message: e.message }); }

    // accessibility
    try {
      const unlabeled = F('unlabeledInputs');
      document.querySelectorAll('input,textarea,select').forEach(f => {
        if (['hidden', 'submit', 'button', 'reset'].includes(f.type)) return;
        const hasLabel = (f.labels && f.labels.length > 0)
          || f.getAttribute('aria-label')
          || f.getAttribute('aria-labelledby')
          || f.getAttribute('title');
        if (!hasLabel) push(unlabeled, { selector: stableSelector(f), code: 'unlabeled-input', message: `${f.tagName.toLowerCase()}[type=${f.type || 'text'}] has no label`, severity: 'error' });
      });
    } catch (e) { ux.errors.push({ collector: 'unlabeledInputs', message: e.message }); }

    try {
      const unnamed = F('unnamedButtons');
      for (const rec of interactiveEls) {
        if ((rec.role === 'button' || rec.role === 'link') && !rec.name) {
          push(unnamed, { ref: rec.ref, selector: rec.selector, code: 'unnamed-control', message: `${rec.role} has empty accessible name`, severity: 'error' });
        }
      }
    } catch (e) { ux.errors.push({ collector: 'unnamedButtons', message: e.message }); }

    try {
      const jumps = F('headingOrderJumps');
      const hs = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(h => parseInt(h.tagName[1], 10));
      for (let i = 1; i < hs.length; i++) {
        if (hs[i] - hs[i - 1] > 1) push(jumps, { code: 'heading-jump', message: `h${hs[i - 1]} → h${hs[i]}`, severity: 'warn' });
      }
    } catch (e) { ux.errors.push({ collector: 'headingOrderJumps', message: e.message }); }

    try {
      const missing = F('missingLandmarks');
      if (!document.querySelector('main,[role="main"]')) push(missing, { code: 'missing-main', message: 'no <main> landmark', severity: 'warn' });
      if (!document.querySelector('nav,[role="navigation"]')) push(missing, { code: 'missing-nav', message: 'no <nav> landmark', severity: 'info' });
      if (!document.querySelector('header,[role="banner"]')) push(missing, { code: 'missing-header', message: 'no <header> landmark', severity: 'info' });
    } catch (e) { ux.errors.push({ collector: 'missingLandmarks', message: e.message }); }

    try {
      const noAlt = F('imagesWithoutAlt');
      document.querySelectorAll('img').forEach(img => {
        if (!img.hasAttribute('alt')) push(noAlt, { selector: stableSelector(img), code: 'img-no-alt', message: 'img without alt attribute', severity: 'error' });
      });
    } catch (e) { ux.errors.push({ collector: 'imagesWithoutAlt', message: e.message }); }

    try {
      const lowContrast = F('lowContrastPairs');
      let checked = 0;
      const all = document.querySelectorAll('p,span,a,button,h1,h2,h3,h4,h5,h6,li,td,th,label,div');
      for (const el of all) {
        if (checked >= 400) break;
        const txt = (el.textContent || '').trim();
        if (!txt || txt.length < 2) continue;
        // only direct-text nodes
        const hasDirectText = Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim());
        if (!hasDirectText) continue;
        if (!isVisible(el)) continue;
        checked++;
        const cs = getComputedStyle(el);
        const fg = parseColor(cs.color);
        if (!fg) continue;
        const bg = effectiveBg(el);
        const ratio = contrastRatio(fg, bg);
        const sizePx = parseFloat(cs.fontSize) || 16;
        const bold = parseInt(cs.fontWeight, 10) >= 700;
        const large = sizePx >= 24 || (sizePx >= 18.66 && bold);
        const threshold = large ? 3 : 4.5;
        if (ratio < threshold) {
          push(lowContrast, { selector: stableSelector(el), code: 'low-contrast', message: `contrast ${ratio.toFixed(2)} < ${threshold}`, severity: 'error', ratio: +ratio.toFixed(2), threshold });
        }
      }
    } catch (e) { ux.errors.push({ collector: 'lowContrastPairs', message: e.message }); }

    ux.device = { label: profile.label, pointer: profile.pointer, minTap: profile.minTap };
    return { map: result, ux };
  }, profile);
}

// Lighter wrapper used by resolveTarget and the runs stale-check.
async function extractPageMap(page) {
  const state = await extractPageState(page);
  return state.map;
}

// Resolve a step target: prefer ref-from-current-pagemap, fallback to selector
async function resolveTarget(page, step) {
  if (step.ref != null) {
    const map = await extractPageMap(page);
    const hit = map.interactables.find(i => i.ref === step.ref);
    if (!hit) throw new Error(`ref ${step.ref} not found on page (${map.interactables.length} interactables)`);
    return page.locator(hit.selector).first();
  }
  if (step.text) {
    return page.getByText(step.text, { exact: step.exact || false }).first();
  }
  if (step.role) {
    return page.getByRole(step.role, step.name ? { name: step.name } : undefined).first();
  }
  if (step.testId) {
    return page.getByTestId(step.testId).first();
  }
  if (step.target) {
    return page.locator(step.target).first();
  }
  throw new Error(`Step has no target (need ref, text, role, testId or target)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Step normalization (lets agent write { click: "<sel>" } or full form)
// ─────────────────────────────────────────────────────────────────────────────

function normalizeStep(raw) {
  if (typeof raw === 'string') {
    const [head, ...rest] = raw.split(' ');
    return { action: head, target: rest.join(' ') };
  }
  const sugar = ['navigate', 'click', 'fill', 'type', 'press', 'select', 'hover', 'scroll', 'eval', 'snapshot', 'pause', 'wait'];
  for (const k of sugar) {
    if (raw[k] !== undefined) {
      const value = raw[k];
      const step = { ...raw, action: k };
      delete step[k];
      if (k === 'fill' && typeof value === 'object' && !Array.isArray(value)) {
        step.fields = value;
      } else if (typeof value === 'number') {
        if (k === 'pause' || k === 'wait') step.ms = value;
        else if (k === 'click' || k === 'hover') step.ref = value;
        else step.value = value;
      } else if (typeof value === 'string') {
        if (k === 'navigate' || k === 'wait' || k === 'click' || k === 'hover' || k === 'scroll') step.target = value;
        else if (k === 'eval') step.value = value;
        else if (k === 'snapshot') step.name = value;
        else step.value = value;
      } else if (typeof value === 'object') {
        Object.assign(step, value);
      }
      return step;
    }
  }
  return raw;
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff
// ─────────────────────────────────────────────────────────────────────────────

function computeDiff(baseline, candidate) {
  const flags = { screenshot: false, dom: false, console: false, network: false, perf: false, layout: false, ux: false, any: false };
  const out = { type: 'diff', baseline: baseline.name, candidate: candidate.name, flags, generatedAt: new Date().toISOString() };

  // Screenshot: size fingerprint (only if both runs captured one)
  if (baseline.outputs?.screenshot && candidate.outputs?.screenshot) {
    try {
      const a = statSync(baseline.outputs.screenshot);
      const b = statSync(candidate.outputs.screenshot);
      const delta = Math.abs(a.size - b.size);
      const pct = a.size ? (delta / a.size) * 100 : 0;
      out.screenshot = { baselineBytes: a.size, candidateBytes: b.size, sizeDeltaPct: +pct.toFixed(2) };
      if (pct > 5) flags.screenshot = true;
    } catch { /* noop */ }
  }

  // DOM: tag-count signature
  if (baseline.outputs?.dom && candidate.outputs?.dom) {
    try {
      const ba = readFileSync(baseline.outputs.dom, 'utf8');
      const ca = readFileSync(candidate.outputs.dom, 'utf8');
      const dom = diffSignatures(tagSignature(ba), tagSignature(ca));
      out.dom = dom;
      if (dom.added > 0 || dom.removed > 0) flags.dom = true;
    } catch { /* noop */ }
  }

  // Console: new errors in candidate are flagged
  if (baseline.outputs?.console && candidate.outputs?.console) {
    try {
      const ba = JSON.parse(readFileSync(baseline.outputs.console, 'utf8'));
      const ca = JSON.parse(readFileSync(candidate.outputs.console, 'utf8'));
      const setBa = new Set(ba.filter(m => m.type === 'error' || m.type === 'pageerror').map(m => m.text));
      const newErrors = ca.filter(m => (m.type === 'error' || m.type === 'pageerror') && !setBa.has(m.text)).map(m => m.text);
      const fixed = ba.filter(m => (m.type === 'error' || m.type === 'pageerror') && !ca.some(c => c.text === m.text)).map(m => m.text);
      out.console = { newErrors, fixed };
      if (newErrors.length > 0) flags.console = true;
    } catch { /* noop */ }
  }

  // Network: new failures (status >= 400) in candidate
  if (baseline.outputs?.network && candidate.outputs?.network) {
    try {
      const ba = JSON.parse(readFileSync(baseline.outputs.network, 'utf8'));
      const ca = JSON.parse(readFileSync(candidate.outputs.network, 'utf8'));
      const failsBa = new Set(ba.filter(r => r.status >= 400).map(r => `${r.method} ${r.url}`));
      const newFails = ca.filter(r => r.status >= 400 && !failsBa.has(`${r.method} ${r.url}`))
        .map(r => ({ url: r.url, status: r.status, method: r.method }));
      out.network = { newFailures: newFails, totalDelta: ca.length - ba.length };
      if (newFails.length > 0) flags.network = true;
    } catch { /* noop */ }
  }

  // Perf: deltas
  const baP = baseline.summary?.perf, caP = candidate.summary?.perf;
  if (baP && caP) {
    const fcpDelta = (caP.fcp ?? 0) - (baP.fcp ?? 0);
    const loadDelta = (caP.load ?? 0) - (baP.load ?? 0);
    out.perf = { fcpDelta: Math.round(fcpDelta), loadDelta: Math.round(loadDelta) };
    if (fcpDelta > 200 || loadDelta > 500) flags.perf = true;
  }

  // Layout: structural compare of embedded geometry (self-contained in manifest)
  if (baseline.layout?.elements && candidate.layout?.elements) {
    const layout = diffLayout(baseline.layout, candidate.layout);
    out.layout = layout;
    if (layout.added > 0 || layout.removed > 0 || layout.moved > 0) flags.layout = true;
  }

  // UX: compare uxReport findings; new findings are regressions
  if (baseline.uxReport && candidate.uxReport) {
    const ux = diffUx(baseline.uxReport, candidate.uxReport);
    out.ux = ux;
    if (ux.newCount > 0) flags.ux = true;
  }

  flags.any = ['screenshot', 'dom', 'console', 'network', 'perf', 'layout', 'ux'].some(k => flags[k]);
  out.verdict = (flags.console || flags.network || flags.ux)
    ? 'regression'
    : (flags.any ? 'changed' : 'neutral');
  out.summaryLine = oneLineDiff(out);
  return out;
}

function diffLayout(a, b) {
  const ma = new Map(a.elements.map(e => [e.ref, e]));
  const mb = new Map(b.elements.map(e => [e.ref, e]));
  let added = 0, removed = 0, moved = 0;
  const movedRefs = [];
  for (const ref of mb.keys()) if (!ma.has(ref)) added++;
  for (const ref of ma.keys()) if (!mb.has(ref)) removed++;
  for (const [ref, ea] of ma) {
    const eb = mb.get(ref);
    if (!eb || !ea.bbox || !eb.bbox) continue;
    const areaA = (ea.bbox.w * ea.bbox.h) || 1;
    const areaB = (eb.bbox.w * eb.bbox.h) || 1;
    const areaDelta = Math.abs(areaB - areaA) / areaA;
    const posDelta = Math.abs(eb.bbox.x - ea.bbox.x) + Math.abs(eb.bbox.y - ea.bbox.y);
    if (areaDelta > 0.1 || posDelta > 0.1 * (a.viewport?.width || 1440)) {
      moved++;
      if (movedRefs.length < 20) movedRefs.push(ref);
    }
  }
  return { added, removed, moved, movedRefs };
}

function diffUx(a, b) {
  const keyOf = (code, f) => `${f.code || code}|${f.ref ?? ''}|${f.selector ?? ''}`;
  const flatten = (rep) => {
    const set = new Set();
    for (const [code, v] of Object.entries(rep)) {
      if (!Array.isArray(v) || code === 'errors') continue;
      for (const f of v) set.add(keyOf(code, f));
    }
    return set;
  };
  const setA = flatten(a), setB = flatten(b);
  const newFindings = [...setB].filter(k => !setA.has(k));
  const resolved = [...setA].filter(k => !setB.has(k));
  return { newFindings, resolved, newCount: newFindings.length, resolvedCount: resolved.length };
}

function tagSignature(html) {
  const counts = {};
  const re = /<([a-zA-Z][\w-]*)\b/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const t = m[1].toLowerCase();
    counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}
function diffSignatures(a, b) {
  let added = 0, removed = 0, mutated = 0;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const ak = a[k] || 0, bk = b[k] || 0;
    if (ak === 0 && bk > 0) added += bk;
    else if (bk === 0 && ak > 0) removed += ak;
    else if (ak !== bk) mutated += Math.abs(ak - bk);
  }
  return { added, removed, mutated };
}
function oneLineDiff(d) {
  const bits = [`verdict=${d.verdict}`];
  if (d.console?.newErrors?.length) bits.push(`+${d.console.newErrors.length} console errors`);
  if (d.network?.newFailures?.length) bits.push(`+${d.network.newFailures.length} failed requests`);
  if (d.ux?.newCount) bits.push(`+${d.ux.newCount} ux findings`);
  if (d.ux?.resolvedCount) bits.push(`-${d.ux.resolvedCount} ux resolved`);
  if (d.layout && (d.layout.added || d.layout.removed || d.layout.moved)) bits.push(`layout +${d.layout.added}/-${d.layout.removed}/~${d.layout.moved}`);
  if (d.perf?.fcpDelta) bits.push(`fcp Δ${d.perf.fcpDelta}ms`);
  if (d.dom?.added || d.dom?.removed) bits.push(`dom +${d.dom.added}/-${d.dom.removed}`);
  if (d.screenshot?.sizeDeltaPct) bits.push(`shot Δ${d.screenshot.sizeDeltaPct}%`);
  return bits.join(' | ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser plumbing
// ─────────────────────────────────────────────────────────────────────────────

// Security: Chromium points at untrusted web content, so the sandbox is the
// main barrier preventing a page exploit from reaching the host FS. Keep it ON
// by default; only drop it where it cannot start (root / common CI / container).
function sandboxDecision(opts) {
  if (opts.noSandbox) return { sandbox: false, reason: 'forced by --no-sandbox' };
  if (opts.sandbox) return { sandbox: true, reason: 'forced by --sandbox' };
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const isCI = !!(process.env.CI || process.env.GITHUB_ACTIONS || process.env.GITLAB_CI || process.env.BUILDKITE);
  const inContainer = existsSync('/.dockerenv') || existsSync('/run/.containerenv');
  if (isRoot || isCI || inContainer) {
    const why = isRoot ? 'running as root' : (isCI ? 'CI environment' : 'container');
    return { sandbox: false, reason: `auto-disabled (${why})` };
  }
  return { sandbox: true, reason: 'default' };
}

function launchArgs(sandbox) {
  const args = ['--disable-gpu', '--disable-dev-shm-usage'];
  if (!sandbox) args.push('--no-sandbox');
  return args;
}

async function launchBrowser(opts) {
  const dec = sandboxDecision(opts);
  if (!dec.sandbox && dec.reason !== 'forced by --no-sandbox') {
    console.error(`note: Chromium sandbox ${dec.reason}. Pass --sandbox to force it on.`);
  }
  try {
    return await chromium.launch({
      executablePath: opts.executable,
      headless: true,
      slowMo: opts.slow ? 250 : 0,
      args: launchArgs(dec.sandbox),
    });
  } catch (err) {
    // If a sandboxed launch fails (e.g. missing kernel namespaces), retry once
    // without the sandbox so the tool still works, but say so loudly.
    if (dec.sandbox) {
      console.error(`note: sandboxed Chromium failed to launch (${err.message.split('\n')[0]}); retrying with --no-sandbox.`);
      return await chromium.launch({
        executablePath: opts.executable,
        headless: true,
        slowMo: opts.slow ? 250 : 0,
        args: launchArgs(false),
      });
    }
    throw err;
  }
}

// Resolve a profile for a single run from opts (preset name, Playwright device,
// or raw viewport). Drives both the context and the device-aware heuristics.
function resolveProfile(opts, presetName) {
  if (presetName && DEVICE_PRESETS[presetName]) {
    const p = DEVICE_PRESETS[presetName];
    return { label: p.label, viewport: p.viewport, pointer: p.pointer, minTap: p.minTap, playwright: p.playwright };
  }
  if (opts.device && devices[opts.device]) {
    const d = devices[opts.device];
    const touch = !!d.hasTouch;
    return {
      label: opts.device,
      viewport: [d.viewport.width, d.viewport.height],
      pointer: touch ? 'coarse' : 'fine',
      minTap: touch ? 44 : 24,
      playwright: opts.device,
    };
  }
  const [vw, vh] = parseViewport(opts.viewport);
  // Infer pointer from width: narrow viewports are treated as touch.
  const touch = vw <= 600;
  return { label: `${vw}x${vh}`, viewport: [vw, vh], pointer: touch ? 'coarse' : 'fine', minTap: touch ? 44 : 24, playwright: null };
}

async function newContext(browser, opts, profile = null) {
  const vp = profile ? profile.viewport : parseViewport(opts.viewport);
  const contextOpts = { viewport: { width: vp[0], height: vp[1] }, colorScheme: opts.dark ? 'dark' : 'light' };
  const pwDevice = profile?.playwright || opts.device;
  if (pwDevice && devices[pwDevice]) Object.assign(contextOpts, devices[pwDevice], { viewport: { width: vp[0], height: vp[1] } });
  if (opts.userAgent) contextOpts.userAgent = opts.userAgent;
  if (opts.authStorage && existsSync(opts.authStorage)) contextOpts.storageState = opts.authStorage;
  return await browser.newContext(contextOpts);
}

// Security: block local-file reads and cloud metadata SSRF by default. The agent
// opts in with --allow-file for local HTML, or --allow-private for LAN targets.
function assertUrlAllowed(url, opts) {
  let u;
  try { u = new URL(url); } catch { return; } // relative/odd inputs handled by Playwright
  const scheme = u.protocol.replace(':', '').toLowerCase();

  if (scheme === 'file') {
    if (!opts.allowFile) throw new Error(`file:// blocked (pass --allow-file to inspect local HTML): ${url}`);
    return;
  }
  if (!['http', 'https'].includes(scheme)) {
    throw new Error(`scheme '${scheme}' not allowed (only http/https; file:// needs --allow-file)`);
  }
  // Cloud metadata endpoints — never allowed regardless of flags.
  const host = u.hostname.toLowerCase();
  const META = new Set(['169.254.169.254', 'metadata.google.internal', '100.100.100.200', 'fd00:ec2::254']);
  if (META.has(host)) throw new Error(`blocked cloud-metadata host: ${host}`);

  if (!opts.allowPrivate && isPrivateHost(host)) {
    throw new Error(`private LAN host blocked (pass --allow-private; localhost is always allowed): ${host}`);
  }
}

function isPrivateHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost')) return false; // dev server: allowed
  // localhost/loopback are the normal dev-server case → allowed. We only block
  // non-localhost private ranges (LAN / link-local / metadata-adjacent).
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false; // hostnames resolve at the network layer; we don't DNS here
  const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  if (a === 127) return false;             // loopback → dev server, allowed
  if (a === 10) return true;               // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

async function navigate(page, url, opts) {
  assertUrlAllowed(url, opts);
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (err) {
    // Best-effort, do not crash.
  }
  if (opts.wait) {
    try { await page.waitForSelector(opts.wait, { timeout: 10000 }); } catch { /* noop */ }
  }
  if (opts.waitMs > 0) await page.waitForTimeout(opts.waitMs);
  return Date.now() - t0;
}

function attachCollectors(page, opts) {
  const consoleMsgs = [];
  const networkEvents = [];
  if (opts.capture.console) {
    page.on('console', msg => consoleMsgs.push({ type: msg.type(), text: msg.text(), location: msg.location() }));
    page.on('pageerror', err => consoleMsgs.push({ type: 'pageerror', text: err.message, stack: err.stack }));
  }
  if (opts.capture.network) {
    page.on('response', res => {
      try {
        const req = res.request();
        networkEvents.push({
          url: res.url(), method: req.method(), status: res.status(),
          type: req.resourceType(), contentType: res.headers()['content-type'] || null,
          timing: typeof res.timing === 'function' ? res.timing() : null,
        });
      } catch { /* noop */ }
    });
  }
  return {
    flushConsole: () => { const a = consoleMsgs.slice(); consoleMsgs.length = 0; return a; },
    flushNetwork: () => { const a = networkEvents.slice(); networkEvents.length = 0; return a; },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Run-dir resolution (ephemeral default, opt-in persistence)
// ─────────────────────────────────────────────────────────────────────────────

function resolveRunDir(opts) {
  // Explicit --out always wins and is treated as persistent (v0.2 back-compat).
  if (opts.outExplicit) {
    const dir = resolve(opts.out);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  if (opts.persistAs) {
    const dir = resolve('./.visual-debug', slugify(opts.persistAs));
    if (existsSync(dir)) {
      console.error(`note: overwriting existing run '${opts.persistAs}' at ${dir}`);
      rmSync(dir, { recursive: true, force: true });
    }
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  if (opts.persist) {
    const auto = `run-${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}`;
    const root = resolve('./.visual-debug');
    const dir = join(root, auto);
    mkdirSync(dir, { recursive: true });
    evictOldRuns(root, opts.keep);
    return dir;
  }
  // Ephemeral default.
  const dir = mkdtempSync(join(tmpdir(), 'visual-debug-'));
  EPHEMERAL_DIR = dir;
  console.error(`run (ephemeral): ${dir}`);
  return dir;
}

function evictOldRuns(root, keep) {
  const k = Number.isFinite(keep) && keep > 0 ? keep : 1;
  let autos;
  try {
    autos = readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith('run-'))
      .map(d => ({ name: d.name, path: join(root, d.name), mtimeMs: statSync(join(root, d.name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch { return; }
  for (const victim of autos.slice(k)) {
    try { rmSync(victim.path, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

function slugify(s) {
  return String(s).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared opts + helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseSharedOpts(rest) {
  const opts = {
    out: './.visual-debug',
    outExplicit: false,
    name: new Date().toISOString().replace(/[:.]/g, '-'),
    viewport: '1440x900',
    device: null,
    deviceMatrix: null, // array of preset names when --device-matrix is set
    wait: null,
    waitMs: 500,
    fullPage: false,
    dark: false,
    capture: { dom: true, console: true, network: true, a11y: true, perf: true, pageMap: true },
    script: null,
    authStorage: null,
    userAgent: null,
    executable: process.env.VISUAL_DEBUG_CHROMIUM || null,
    slow: false,
    quiet: false,
    failOn: null,
    // v0.3
    persist: false,
    persistAs: null,
    keep: 1,
    emitManifest: false,
    screenshotMode: 'off', // off | all | on-issue
    screenshotFormat: 'webp',
    // v0.4 security
    sandbox: false,      // force sandbox ON
    noSandbox: false,    // force sandbox OFF
    noEval: false,       // disable flow eval steps
    allowFile: false,    // permit file:// navigation
    allowPrivate: false, // permit private-LAN hosts (localhost always allowed)
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = () => rest[++i];
    switch (a) {
      case '--out': opts.out = next(); opts.outExplicit = true; break;
      case '--name': opts.name = next(); break;
      case '--viewport': opts.viewport = next(); break;
      case '--device': opts.device = next(); break;
      case '--device-matrix': {
        const v = next();
        const names = (v === undefined || v.startsWith('--')) ? ['mobile', 'tablet', 'desktop'] : v.split(',').map(s => s.trim());
        if (v && v.startsWith('--')) i--; // it was the next flag, not a value
        const valid = names.filter(n => DEVICE_PRESETS[n]);
        opts.deviceMatrix = valid.length ? valid : ['mobile', 'tablet', 'desktop'];
        break;
      }
      case '--wait': opts.wait = next(); break;
      case '--wait-ms': opts.waitMs = parseInt(next(), 10); break;
      case '--full-page': opts.fullPage = true; break;
      case '--dark': opts.dark = true; break;
      case '--no-screenshot': opts.screenshotMode = 'off'; break;
      case '--no-console': opts.capture.console = false; break;
      case '--no-network': opts.capture.network = false; break;
      case '--no-dom': opts.capture.dom = false; break;
      case '--no-a11y': opts.capture.a11y = false; break;
      case '--no-perf': opts.capture.perf = false; break;
      case '--no-page-map': opts.capture.pageMap = false; break;
      case '--script': opts.script = next(); break;
      case '--auth-storage': opts.authStorage = next(); break;
      case '--user-agent': opts.userAgent = next(); break;
      case '--executable': opts.executable = next(); break;
      case '--slow': opts.slow = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--fail-on': opts.failOn = next(); break;
      // v0.3 flags
      case '--persist': opts.persist = true; break;
      case '--persist-as': opts.persistAs = next(); break;
      case '--keep': opts.keep = parseInt(next(), 10); break;
      case '--emit-manifest': opts.emitManifest = true; break;
      case '--screenshots': opts.screenshotMode = 'all'; break;
      case '--screenshot-on-issue': opts.screenshotMode = 'on-issue'; break;
      case '--screenshot-format': opts.screenshotFormat = next(); break;
      // v0.4 security flags
      case '--sandbox': opts.sandbox = true; break;
      case '--no-sandbox': opts.noSandbox = true; break;
      case '--no-eval': opts.noEval = true; break;
      case '--allow-file': opts.allowFile = true; break;
      case '--allow-private': opts.allowPrivate = true; break;
      default: /* tolerate unknowns when called via dispatcher */ break;
    }
  }
  return opts;
}

function detectMode(argv) {
  if (argv[0] === 'runs') return 'runs';
  if (argv.includes('--diff') || argv.includes('--diff-against')) return 'diff';
  if (argv.includes('--flow')) return 'flow';
  return 'url';
}
function cliHas(argv, flag) { return argv.includes(flag); }
function parseViewport(v) { return v.split('x').map(n => parseInt(n, 10)); }
function defaultChromium() {
  // 1) Explicit override always wins.
  if (process.env.VISUAL_DEBUG_CHROMIUM) return process.env.VISUAL_DEBUG_CHROMIUM;

  // 2) Ask Playwright where its bundled Chromium is. This tracks the version
  //    Playwright expects and is portable across machines/users.
  let expected = null;
  try { expected = chromium.executablePath(); } catch { /* noop */ }
  if (expected && existsSync(expected)) return expected;

  // 3) Version drift: Playwright was upgraded but `playwright install` wasn't
  //    re-run, so the expected build (e.g. chromium-1223) is missing while an
  //    older one (chromium-1217) still sits in the cache. Scan the cache root
  //    for ANY installed Chromium and use the newest. Keeps the tool working
  //    instead of hard-failing on a build-number mismatch.
  const cacheRoot = expected
    ? expected.slice(0, expected.indexOf('ms-playwright') + 'ms-playwright'.length)
    : null;
  if (cacheRoot && existsSync(cacheRoot)) {
    try {
      const builds = readdirSync(cacheRoot, { withFileTypes: true })
        .filter(d => d.isDirectory() && /^chromium-\d+$/.test(d.name))
        .map(d => ({ n: parseInt(d.name.split('-')[1], 10), name: d.name }))
        .sort((a, b) => b.n - a.n);
      for (const b of builds) {
        for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
          const cand = join(cacheRoot, b.name, sub);
          if (existsSync(cand)) return cand;
        }
      }
    } catch { /* noop */ }
  }

  // 4) Last resort: return the expected path (may be null) so the caller emits
  //    the "run playwright install" hint.
  return expected;
}
function chromiumNotFound(p) {
  console.error(`Chromium not found at ${p}.\nSet VISUAL_DEBUG_CHROMIUM, pass --executable, or run: npx playwright install chromium`);
  process.exit(3);
}
function readStdin() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  let n;
  while (true) {
    try { n = readSync(0, buf, 0, buf.length, null); }
    catch { break; }
    if (!n) break;
    chunks.push(buf.slice(0, n).toString('utf8'));
  }
  return chunks.join('');
}

// Emit policy:
//   --emit-manifest : full manifest JSON → stdout; human summary → stderr.
//   --quiet         : only manifest JSON → stdout.
//   default         : manifest JSON → stdout; run path/summary → stderr.
function emit(manifest, opts) {
  const json = JSON.stringify(manifest, null, 2);
  if (opts.emitManifest) {
    process.stdout.write(json + '\n');
    console.error(summaryLine(manifest));
    return;
  }
  if (opts.quiet) {
    process.stdout.write(json + '\n');
    return;
  }
  console.log(json);
  if (manifest.manifestPath) console.error(`manifest: ${manifest.manifestPath}`);
}

function summaryLine(m) {
  if (m.type === 'diff') return m.summaryLine || 'diff';
  if (m.type === 'flow') {
    const failed = (m.steps || []).filter(s => s.status === 'failed').length;
    return `flow '${m.flowName}' — ${(m.steps || []).length} steps, ${failed} failed, ${(m.snapshots || []).length} snapshots${m.aborted ? ' (ABORTED)' : ''}`;
  }
  const ux = m.summary?.uxFindings ? Object.entries(m.summary.uxFindings).filter(([, n]) => n).map(([k, n]) => `${k}:${n}`).join(' ') : '';
  return `snapshot '${m.name}' — ${m.summary?.pageMap?.interactables ?? 0} interactables${ux ? ' | ux ' + ux : ''}${m.screenshot ? ' | shot' : ''}`;
}

function printHelp() {
  console.log(`visual-debug v0.4 — the agent's UI/UX inspector.

Ephemeral by default: a run lives in a tmp dir and is deleted on exit.
Signature output is a layout SVG + uxReport heuristics (vector, not pixels).
Screenshots are opt-in.

Modes:
  URL :   visual-debug <url> [options]                  — one-shot snapshot
  Flow:   visual-debug --flow <file|->                  — declarative multi-step
  Diff:   visual-debug --diff <baseline> <candidate>    — compare two manifests
          visual-debug --diff-against <baseline> <cand> — same, <cand> may be '-'
  Runs:   visual-debug runs --list | --prune-stale | --prune-older-than <d> | --clean

Persistence (default is ephemeral):
  --persist              Persist to .visual-debug/run-<timestamp>/
  --persist-as <name>    Persist to .visual-debug/<name>/ (overwrites)
  --keep <N>             Keep at most N auto runs (with --persist; default 1)
  --out <dir>            Explicit output dir (persistent; v0.2 back-compat)

Output:
  --emit-manifest        Full manifest JSON → stdout, summary → stderr (pipe-friendly)
  --quiet                Only emit JSON to stdout

Screenshots (off by default):
  --screenshots          Raster every snapshot
  --screenshot-on-issue  Raster only when a uxReport finding has severity 'error'
  --screenshot-format <png|webp|jpeg>   Default webp (falls back to jpeg q70)

Devices (device-aware heuristics: tap targets, overflow severity adapt):
  --device <name>        Playwright device descriptor (e.g. "iPhone 14")
  --device-matrix [list] Run the same URL across form factors in one shot and
                         emit a cross-device comparison. Default presets:
                         mobile,tablet,desktop. e.g. --device-matrix mobile,desktop

Security (Chromium opens untrusted web content):
  --sandbox              Force Chromium sandbox ON
  --no-sandbox           Force sandbox OFF (default: ON, auto-off on root/CI/container)
  --no-eval              Disable flow 'eval' steps
  --allow-file           Permit file:// navigation (blocked by default)
  --allow-private        Permit private-LAN hosts (localhost always allowed;
                         cloud-metadata hosts always blocked)

Shared options:
  --name <basename>      Basename for outputs (default: timestamp)
  --viewport <WxH>       Default 1440x900
  --wait <selector>      Wait for selector before first snapshot
  --wait-ms <ms>         Extra wait after load (default 500)
  --full-page            Full-page screenshots (when raster enabled)
  --dark                 Dark colorScheme
  --no-screenshot --no-dom --no-console --no-network --no-a11y --no-perf
  --no-page-map          Skip interactable inventory (also disables SVG + uxReport)
  --auth-storage <path>  storageState JSON
  --user-agent <str>     Override UA
  --executable <path>    Chromium binary
  --slow                 250ms slowMo
  -h, --help             Show this help
  --fail-on <kinds>      Diff exit code: comma list of
                         {console,network,perf,dom,screenshot,layout,ux,any}
                         Default: console,network

Examples:
  visual-debug https://example.com
  visual-debug https://example.com --device-matrix
  visual-debug https://example.com --persist-as home-baseline
  visual-debug --flow flow.json --emit-manifest > baseline.json
  visual-debug --flow flow.json --emit-manifest | visual-debug --diff-against baseline.json -
  visual-debug --diff baseline.json after.json --fail-on layout,ux
  visual-debug runs --list
  visual-debug runs --prune-stale --yes
`);
}
