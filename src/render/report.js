import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { dur } from '../format.js';
import { tips } from '../tips.js';
import { cardSvg } from './card.js';

const MAX_POINTS = 1500;
const read = (/** @type {string} */ f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
const esc = (/** @type {string} */ s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The data the page needs, small enough to embed.
 * @param {import('../analyze.js').Analysis} a
 */
export function reportData(a) {
  const models = [...new Set(a.timeline.map((t) => t.model))];
  const missAt = new Map(a.cache.misses.map((m, i) => [m.ts, i]));
  const step = Math.max(1, Math.ceil(a.timeline.length / MAX_POINTS));
  /** @type {number[][]} */
  const points = [];
  a.timeline.forEach((t, i) => {
    const miss = missAt.has(t.ts) ? /** @type {number} */ (missAt.get(t.ts)) : -1;
    if (i % step !== 0 && miss < 0 && i !== a.timeline.length - 1) return;
    points.push([i, t.ts, t.read, t.write, t.input, round(t.cost), round(t.cum), models.indexOf(t.model), miss]);
  });
  const compactionIdx = a.compactions
    .filter((c) => c.agent === 'main')
    .map((c) => points.findIndex((p) => p[1] >= c.ts))
    .filter((i) => i >= 0);

  return {
    id: a.id,
    title: a.title,
    project: a.project,
    start: a.start,
    duration: dur(a.durationMs),
    totals: a.totals,
    byModel: a.byModel,
    mainCost: a.mainCost,
    agents: a.agents,
    cache: { hitRate: a.cache.hitRate, savedUsd: a.cache.savedUsd, lostUsd: a.cache.lostUsd },
    misses: a.cache.misses,
    compactions: a.compactions.length,
    compactionIdx,
    peakContext: a.peakContext,
    eaters: a.eaters,
    trim: a.trim,
    tips: tips(a).slice(0, 5).map((t) => t.text),
    models,
    points,
    card: cardSvg(a),
  };
}

const round = (/** @type {number} */ n) => Math.round(n * 10000) / 10000;

/** @param {import('../analyze.js').Analysis} a */
export function reportHtml(a) {
  const data = JSON.stringify(reportData(a)).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receipt · ${esc(a.title)}</title>
<style>${read('./report.css')}</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div>
      <div class="brand">Receipts · Context X-ray</div>
      <h1 id="title"></h1>
      <div class="meta" id="meta"></div>
    </div>
    <div class="actions">
      <button id="dlPng" type="button">Download card (PNG)</button>
    </div>
  </header>

  <div class="tiles" id="tiles"></div>

  <section class="card">
    <h2>Context size, call by call</h2>
    <p class="sub">Every API call sends the whole conversation again. Reads from the cache are cheap; writes cost 1.25x to 2x the input price. Red markers are cache misses, where the cache was rebuilt.</p>
    <div class="legend">
      <span><i style="background:var(--s1)"></i>Read from cache</span>
      <span><i style="background:var(--s2)"></i>Written to cache</span>
      <span><i style="background:var(--s3)"></i>Fresh input</span>
      <span><i class="tri"></i>Cache miss</span>
      <span><i class="dash"></i>Compaction</span>
    </div>
    <div class="chart" id="ctxChart"></div>
    <details>
      <summary>Show as a table</summary>
      <div class="tablewrap">
        <table id="ctxTable">
          <thead><tr><th>Call</th><th>Time</th><th>Model</th><th class="num">Context</th><th class="num">Cached</th><th class="num">Written</th><th class="num">Running cost</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </details>
  </section>

  <section class="card">
    <h2>Running cost</h2>
    <p class="sub">Steep stretches are long contexts or cache rebuilds. Flat stretches are cheap turns.</p>
    <div class="chart" id="costChart"></div>
  </section>

  <div class="grid2">
    <section class="card">
      <h2>Where the money went</h2>
      <p class="sub">The four things you pay for on every call.</p>
      <div class="bars" id="meters"></div>
    </section>
    <section class="card">
      <h2>By model</h2>
      <p class="sub">Main conversation and subagents together.</p>
      <div class="bars" id="models"></div>
    </section>
  </div>

  <section class="card" id="agentsCard">
    <h2>Subagents</h2>
    <p class="sub">Each subagent has its own context and its own bill.</p>
    <div class="bars" id="agents"></div>
  </section>

  <div class="grid2">
    <section class="card">
      <h2>Cache misses</h2>
      <p class="sub">Calls that rebuilt a cache they could have read. Cost is the extra paid over a cache read.</p>
      <div class="tablewrap">
        <table id="missTable">
          <thead><tr><th>When</th><th>Cause</th><th>Gap</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </section>
    <section class="card">
      <h2>What filled the context</h2>
      <p class="sub">Tool results in the main conversation, estimated tokens.</p>
      <div class="bars" id="eaters"></div>
    </section>
  </div>

  <section class="card">
    <h2>How to pay less next time</h2>
    <p class="sub">Computed from this session's own numbers.</p>
    <ol class="tips" id="tips"></ol>
  </section>

  <section class="card">
    <div class="share">
      <div class="preview" id="preview"></div>
      <div>
        <h2>Share your receipt</h2>
        <p class="sub">A till-style card with your totals. No file paths or code, just numbers.</p>
        <div class="actions">
          <button id="dlPng2" type="button" onclick="document.getElementById('dlPng').click()">Download PNG</button>
          <button id="dlSvg" type="button">Download SVG</button>
        </div>
      </div>
    </div>
  </section>

  <footer>Computed locally from Claude Code transcripts at Anthropic list prices. Plans, discounts and gateways can change your real bill. Made with Receipts.</footer>
</div>
<script type="application/json" id="data">${data}</script>
<script>${read('./report-client.js')}</script>
</body>
</html>`;
}

/**
 * @param {import('../analyze.js').Analysis} a
 * @param {{ out?: string, open?: boolean }} opts
 */
export function writeReport(a, opts = {}) {
  const out = path.resolve(opts.out || path.join(os.tmpdir(), `receipt-${a.id.slice(0, 8)}.html`));
  fs.writeFileSync(out, reportHtml(a));
  console.log(`Saved ${out}`);
  if (opts.open) openFile(out);
  return out;
}

/** @param {string} file */
function openFile(file) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', file] : [file];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* printing the path is enough */
  }
}
