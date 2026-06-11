#!/usr/bin/env node
/**
 * visual-debug v0.2 — agent-first headless browser snapshots, flows and diffs.
 *
 * Three modes:
 *   1) URL  : visual-debug <url> [opts]                — one-shot snapshot.
 *   2) Flow : visual-debug --flow <file|->            — declarative multi-step.
 *   3) Diff : visual-debug --diff <baseline> <candidate> — compare two manifests.
 *
 * Designed to be driven by AI agents (Claude Code, Droid, Cursor, etc.) with
 * zero MCP context cost. Every snapshot includes a "page map" listing every
 * interactable element with a stable ref, so the agent can navigate the page
 * by index without ever seeing the screen.
 *
 * See README for full docs.
 */

import { chromium, devices } from 'playwright';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync, readSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';

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

if (mode === 'diff') {
  await runDiffMode(argv);
} else if (mode === 'flow') {
  await runFlowMode(argv);
} else {
  await runUrlMode(argv);
}

// ─────────────────────────────────────────────────────────────────────────────
// Mode: URL (v0.1 compatible)
// ─────────────────────────────────────────────────────────────────────────────

async function runUrlMode(argv) {
  const url = argv[0];
  const opts = parseSharedOpts(argv.slice(1));

  if (!opts.executable) opts.executable = defaultChromium();
  if (!existsSync(opts.executable)) chromiumNotFound(opts.executable);

  process.env.QT_QPA_PLATFORM = process.env.QT_QPA_PLATFORM || 'xcb';

  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });

  const browser = await launchBrowser(opts);
  const context = await newContext(browser, opts);
  const page = await context.newPage();
  const collectors = attachCollectors(page, opts);

  const navMs = await navigate(page, url, opts);

  const manifest = await snapshot(page, {
    name: opts.name,
    outDir,
    url,
    navMs,
    viewport: parseViewport(opts.viewport),
    device: opts.device,
    colorScheme: opts.dark ? 'dark' : 'light',
    collectors,
    captureFlags: opts.capture,
    fullPage: opts.fullPage,
  });

  await context.close();
  await browser.close();

  emit(manifest, opts.quiet);
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
  if (!existsSync(opts.executable)) chromiumNotFound(opts.executable);
  process.env.QT_QPA_PLATFORM = process.env.QT_QPA_PLATFORM || 'xcb';

  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });

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
        await el.type(String(step.value), { delay: step.delay || 0 });
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
        });
        snapshots.push(snap);
        entry.snapshot = snap.manifestPath;
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
      summary: s.summary,
    })),
    generatedAt: new Date().toISOString(),
  };
  const flowPath = join(outDir, `${opts.name}.flow.json`);
  writeFileSync(flowPath, JSON.stringify(flowManifest, null, 2));
  flowManifest.manifestPath = flowPath;

  emit(flowManifest, opts.quiet);
  process.exit(aborted ? 1 : 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Mode: Diff
// ─────────────────────────────────────────────────────────────────────────────

async function runDiffMode(argv) {
  const i = argv.indexOf('--diff');
  const baselinePath = argv[i + 1];
  const candidatePath = argv[i + 2];
  if (!baselinePath || !candidatePath) {
    console.error('--diff requires <baseline-manifest> <candidate-manifest>');
    process.exit(2);
  }

  const opts = parseSharedOpts(argv.filter((_, ix) => ix < i || ix > i + 2));
  const baseline = JSON.parse(readFileSync(resolve(baselinePath), 'utf8'));
  const candidate = JSON.parse(readFileSync(resolve(candidatePath), 'utf8'));

  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });

  const diff = computeDiff(baseline, candidate);
  const diffPath = join(outDir, `${opts.name}.diff.json`);
  writeFileSync(diffPath, JSON.stringify(diff, null, 2));
  diff.manifestPath = diffPath;

  emit(diff, opts.quiet);

  const failOn = (opts.failOn || 'console,network').split(',').map(s => s.trim());
  const shouldFail = failOn.some(k => diff.flags[k]);
  process.exit(shouldFail ? 1 : 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot pipeline (shared by URL + Flow)
// ─────────────────────────────────────────────────────────────────────────────

async function snapshot(page, ctx) {
  const base = join(ctx.outDir, ctx.name);
  const paths = {
    screenshot: `${base}.png`,
    dom: `${base}.dom.html`,
    console: `${base}.console.json`,
    network: `${base}.network.json`,
    a11y: `${base}.a11y.json`,
    perf: `${base}.perf.json`,
    pageMap: `${base}.map.json`,
    manifest: `${base}.manifest.json`,
  };
  const manifest = {
    type: 'snapshot',
    name: ctx.name,
    url: ctx.url,
    finalUrl: page.url(),
    title: await page.title().catch(() => null),
    navMs: ctx.navMs,
    viewport: ctx.viewport,
    device: ctx.device,
    colorScheme: ctx.colorScheme,
    outputs: {},
    summary: {},
    generatedAt: new Date().toISOString(),
  };

  const cap = ctx.captureFlags;

  if (cap.screenshot) {
    try {
      await page.screenshot({ path: paths.screenshot, fullPage: ctx.fullPage });
      manifest.outputs.screenshot = paths.screenshot;
    } catch (err) { manifest.summary.screenshotError = err.message; }
  }
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
      // Playwright accessibility API was removed in newer versions; fall back
      // to a self-rolled DOM-based a11y dump that mirrors the most useful bits.
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
  if (cap.pageMap) {
    try {
      const map = await extractPageMap(page);
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
    } catch (err) { manifest.summary.pageMapError = err.message; }
  }

  writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2));
  manifest.manifestPath = paths.manifest;
  return manifest;
}

// ─────────────────────────────────────────────────────────────────────────────
// Page map — agent-friendly inventory of interactables
// ─────────────────────────────────────────────────────────────────────────────

async function extractPageMap(page) {
  return await page.evaluate(() => {
    const result = { interactables: [], forms: [], landmarks: [], scrollable: [], headings: [] };
    let counter = 0;

    const stableSelector = (el) => {
      if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;
      for (const attr of ['data-testid', 'data-test', 'data-cy', 'data-qa', 'data-action', 'name']) {
        const v = el.getAttribute?.(attr);
        if (v) return `[${attr}="${CSS.escape(v)}"]`;
      }
      const tag = el.tagName.toLowerCase();
      const aria = el.getAttribute?.('aria-label');
      if (aria) return `${tag}[aria-label="${CSS.escape(aria)}"]`;
      // Fallback to nth-of-type chain (capped)
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

    const interactiveSel = [
      'a[href]', 'button', 'input', 'textarea', 'select', 'summary', 'label',
      '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
      '[role="tab"]', '[role="menuitem"]', '[role="switch"]', '[role="option"]',
      '[onclick]', '[tabindex]:not([tabindex="-1"])',
    ].join(',');

    document.querySelectorAll(interactiveSel).forEach(el => {
      if (!isVisible(el)) return;
      const r = el.getBoundingClientRect();
      result.interactables.push({
        ref: ++counter,
        role: role(el),
        name: accessibleName(el),
        selector: stableSelector(el),
        value: el.value ?? null,
        checked: el.checked ?? null,
        disabled: el.disabled ?? null,
        bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      });
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
      result.landmarks.push({ role: role(el), selector: stableSelector(el), name: accessibleName(el) });
    });

    document.querySelectorAll('h1,h2,h3').forEach(h => {
      if (!isVisible(h)) return;
      result.headings.push({ level: parseInt(h.tagName[1], 10), text: (h.textContent || '').trim().slice(0, 120), selector: stableSelector(h) });
    });

    return result;
  });
}

// Resolve a step target: prefer ref-from-last-pagemap, fallback to selector
async function resolveTarget(page, step) {
  if (step.ref != null) {
    // Re-extract page map and find by ref. Refs are positional within a run,
    // so we re-derive selectors and use the selector. Cheap and stateless.
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
    // shorthand: "navigate https://...", "snapshot name", "pause 500"
    const [head, ...rest] = raw.split(' ');
    return { action: head, target: rest.join(' ') };
  }
  // Sugar: { click: "<sel-or-ref>" } → { action: 'click', target: ... }
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
  const flags = { screenshot: false, dom: false, console: false, network: false, perf: false, any: false };
  const out = { type: 'diff', baseline: baseline.name, candidate: candidate.name, flags, generatedAt: new Date().toISOString() };

  // Screenshot: size + mtime fingerprint (cheap; pixelmatch is opt-in via roadmap)
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

  // DOM: read both files, compare structure roughly (tag-count signature)
  if (baseline.outputs?.dom && candidate.outputs?.dom) {
    try {
      const ba = readFileSync(baseline.outputs.dom, 'utf8');
      const ca = readFileSync(candidate.outputs.dom, 'utf8');
      const sigA = tagSignature(ba);
      const sigB = tagSignature(ca);
      const dom = diffSignatures(sigA, sigB);
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

  flags.any = Object.values(flags).some(Boolean);
  out.verdict = flags.any
    ? (flags.console || flags.network ? 'regression' : 'changed')
    : 'neutral';
  out.summaryLine = oneLineDiff(out);
  return out;
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
  if (d.perf?.fcpDelta) bits.push(`fcp Δ${d.perf.fcpDelta}ms`);
  if (d.dom?.added || d.dom?.removed) bits.push(`dom +${d.dom.added}/-${d.dom.removed}`);
  if (d.screenshot?.sizeDeltaPct) bits.push(`png Δ${d.screenshot.sizeDeltaPct}%`);
  return bits.join(' | ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser plumbing
// ─────────────────────────────────────────────────────────────────────────────

async function launchBrowser(opts) {
  return await chromium.launch({
    executablePath: opts.executable,
    headless: true,
    slowMo: opts.slow ? 250 : 0,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
}

async function newContext(browser, opts) {
  const [vw, vh] = parseViewport(opts.viewport);
  const contextOpts = { viewport: { width: vw, height: vh }, colorScheme: opts.dark ? 'dark' : 'light' };
  if (opts.device && devices[opts.device]) Object.assign(contextOpts, devices[opts.device]);
  if (opts.userAgent) contextOpts.userAgent = opts.userAgent;
  if (opts.authStorage && existsSync(opts.authStorage)) contextOpts.storageState = opts.authStorage;
  return await browser.newContext(contextOpts);
}

async function navigate(page, url, opts) {
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
// Shared opts + helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseSharedOpts(rest) {
  const opts = {
    out: './.visual-debug',
    name: new Date().toISOString().replace(/[:.]/g, '-'),
    viewport: '1440x900',
    device: null,
    wait: null,
    waitMs: 500,
    fullPage: false,
    dark: false,
    capture: { screenshot: true, dom: true, console: true, network: true, a11y: true, perf: true, pageMap: true },
    script: null,
    authStorage: null,
    userAgent: null,
    executable: process.env.VISUAL_DEBUG_CHROMIUM || null,
    slow: false,
    quiet: false,
    failOn: null,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = () => rest[++i];
    switch (a) {
      case '--out': opts.out = next(); break;
      case '--name': opts.name = next(); break;
      case '--viewport': opts.viewport = next(); break;
      case '--device': opts.device = next(); break;
      case '--wait': opts.wait = next(); break;
      case '--wait-ms': opts.waitMs = parseInt(next(), 10); break;
      case '--full-page': opts.fullPage = true; break;
      case '--dark': opts.dark = true; break;
      case '--no-screenshot': opts.capture.screenshot = false; break;
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
      default: /* tolerate unknowns when called via dispatcher */ break;
    }
  }
  return opts;
}

function detectMode(argv) {
  if (argv.includes('--diff')) return 'diff';
  if (argv.includes('--flow')) return 'flow';
  return 'url';
}
function cliHas(argv, flag) { return argv.includes(flag); }
function parseViewport(v) { return v.split('x').map(n => parseInt(n, 10)); }
function defaultChromium() {
  return '/home/jcibernet/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';
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
function emit(manifest, quiet) {
  const json = JSON.stringify(manifest, null, 2);
  if (quiet) process.stdout.write(json + '\n');
  else console.log(json);
}

function printHelp() {
  console.log(`visual-debug v0.2 — agent-first headless browser snapshots, flows and diffs.

Three modes:

  URL mode:
    visual-debug <url> [options]                  — one-shot snapshot

  Flow mode (multi-step, agent-driven):
    visual-debug --flow <file|->                  — run a JSON flow recipe

  Diff mode:
    visual-debug --diff <baseline> <candidate>    — compare two manifests

Shared options:
  --out <dir>            Output directory (default: ./.visual-debug)
  --name <basename>      Basename for outputs (default: timestamp)
  --viewport <WxH>       Default 1440x900
  --device <name>        Playwright device descriptor (e.g. "iPhone 14")
  --wait <selector>      Wait for selector before first snapshot
  --wait-ms <ms>         Extra wait after load (default 500)
  --full-page            Full-page screenshots
  --dark                 Dark colorScheme
  --no-screenshot --no-dom --no-console --no-network --no-a11y --no-perf
  --no-page-map          Skip interactable inventory
  --script <path>        Run JS file inside page
  --auth-storage <path>  storageState JSON
  --user-agent <str>     Override UA
  --executable <path>    Chromium binary
  --slow                 250ms slowMo
  --quiet                Only emit JSON
  --fail-on <kinds>      Diff exit code: comma list of {console,network,perf,dom,screenshot,any}
                         Default: console,network

Flow JSON shape:
  {
    "name": "checkout",
    "baseUrl": "http://localhost:3000",
    "viewport": "1440x900",
    "continueOnError": false,
    "finalSnapshot": true,
    "steps": [
      { "navigate": "/checkout" },
      { "wait": "[data-step=address]" },
      { "snapshot": "address-form" },
      { "fill": { "[name=email]": "x@y.com", "[name=zip]": "1414" } },
      { "click": { "ref": 7 } },
      { "click": "[data-action=next]" },
      { "wait": "[data-step=payment]" },
      { "snapshot": "payment-form", "fullPage": true },
      { "eval": "() => window.location.pathname" },
      { "pause": 300 }
    ]
  }

Step targeting (in order of preference for agents):
  { "click": { "ref": 7 } }                  — by index from the previous page map
  { "click": { "role": "button", "name": "Pay" } }
  { "click": { "text": "Continue" } }
  { "click": { "testId": "submit" } }
  { "click": "[data-action=pay]" }           — raw CSS selector

The "actions" array in each snapshot manifest lists every interactable with
a stable ref the agent can target. The full map lives at <name>.map.json.

Examples:
  visual-debug https://example.com
  visual-debug --flow flows/checkout.json
  echo '{"steps":[{"navigate":"https://example.com"},{"snapshot":"home"}]}' | visual-debug --flow -
  visual-debug --diff ./.visual-debug/before.manifest.json ./.visual-debug/after.manifest.json
`);
}
