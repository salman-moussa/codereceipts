import { listSessions, loadSession } from './transcripts.js';
import { analyze } from './analyze.js';
import { readLedger } from './ledger.js';
import { usd, num, shortModel, CAUSE_TEXT } from './format.js';
import { barcode, wrap } from './render/receipt.js';
import path from 'node:path';

const W = 46;
const row = (/** @type {string} */ l, /** @type {string} */ r) => {
  const room = W - l.length - r.length - 2;
  return room < 1 ? `${l.slice(0, W - r.length - 3)}… ${r}` : `${l} ${'.'.repeat(room)} ${r}`;
};

/**
 * Totals across every project for the last N days. Only calls inside the
 * window count, so a long session that started earlier is split correctly.
 * @param {{ days: number, json?: boolean, color?: boolean }} opts
 */
export async function week({ days, json = false, color = false }) {
  const since = Date.now() - days * 86_400_000;
  const files = listSessions().filter((s) => s.mtime >= since);
  const ledger = readLedger();

  const sum = { cost: 0, noCache: 0, lost: 0, trimmed: 0, trimUsd: 0, calls: 0, sessions: 0 };
  /** @type {Map<string, number>} */ const byDay = new Map();
  /** @type {Map<string, number>} */ const byProject = new Map();
  /** @type {Map<string, number>} */ const byModel = new Map();
  /** @type {Map<string, { n: number, usd: number }>} */ const byCause = new Map();
  /** @type {{ title: string, cost: number, id: string }[]} */ const top = [];

  for (const f of files) {
    const s = await loadSession(f.file);
    s.calls = s.calls.filter((c) => c.ts >= since);
    if (!s.calls.length) continue;
    const a = analyze(s, ledger.filter((e) => e.session === s.id && e.ts >= since));
    sum.sessions++;
    sum.cost += a.totals.cost;
    sum.noCache += a.totals.noCache;
    sum.lost += a.cache.lostUsd;
    sum.trimmed += a.trim.savedTokens;
    sum.trimUsd += a.trim.savedUsd;
    sum.calls += a.totals.calls;
    top.push({ title: a.title, cost: a.totals.cost, id: a.id });
    const project = projectName(s.cwd, f.file);
    byProject.set(project, (byProject.get(project) || 0) + a.totals.cost);
    for (const m of a.byModel) byModel.set(m.model, (byModel.get(m.model) || 0) + m.cost);
    for (const m of a.cache.misses) {
      const c = byCause.get(m.cause) || { n: 0, usd: 0 };
      c.n++;
      c.usd += m.lost;
      byCause.set(m.cause, c);
    }
    for (const c of s.calls) {
      const day = new Date(c.ts).toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + /** @type {any} */ (c).cost.total);
    }
  }

  const result = {
    days,
    ...sum,
    cachingSaved: sum.noCache - sum.cost,
    byDay: [...byDay.entries()].sort(),
    byProject: [...byProject.entries()].sort((a, b) => b[1] - a[1]),
    byModel: [...byModel.entries()].sort((a, b) => b[1] - a[1]),
    misses: [...byCause.entries()].sort((a, b) => b[1].usd - a[1].usd),
    top: top.sort((a, b) => b.cost - a.cost).slice(0, 5),
  };
  if (json) return void console.log(JSON.stringify(result, null, 2));

  const bold = (/** @type {string} */ s) => (color ? `\x1b[1m${s}\x1b[22m` : s);
  const L = ['', `${' '.repeat(15)}${bold('R E C E I P T S')}`, `${' '.repeat(Math.floor((W - 22 - String(days).length) / 2))}last ${days} days, all projects`, '='.repeat(W)];
  L.push(row('Sessions', String(sum.sessions)), row('API calls', num(sum.calls)), '-'.repeat(W));

  const max = Math.max(...result.byDay.map((d) => d[1]), 1e-9);
  for (const [day, usdDay] of result.byDay) {
    const bar = '█'.repeat(Math.max(1, Math.round((usdDay / max) * 18)));
    L.push(`${day.slice(5)}  ${bar.padEnd(18)} ${usd(usdDay).padStart(W - 26)}`);
  }
  L.push('-'.repeat(W));
  for (const [p, c] of result.byProject.slice(0, 6)) L.push(row(p.slice(0, 30), usd(c)));
  L.push('-'.repeat(W));
  for (const [m, c] of result.byModel.slice(0, 4)) L.push(row(shortModel(m), usd(c)));
  L.push('='.repeat(W), bold(row('TOTAL', usd(sum.cost))), '='.repeat(W));
  L.push(row('Caching saved you', usd(Math.max(0, result.cachingSaved))));
  L.push(row('Lost to cache misses', usd(sum.lost)));
  for (const [cause, v] of result.misses.slice(0, 3)) L.push(row(`  ${v.n}x ${CAUSE_TEXT[/** @type {keyof typeof CAUSE_TEXT} */ (cause)] || cause}`, usd(v.usd)));
  if (sum.trimmed) L.push(row(`Trimmed ${num(sum.trimmed)} tokens`, usd(sum.trimUsd)));
  if (result.top.length) {
    L.push('-'.repeat(W), bold('MOST EXPENSIVE SESSIONS'));
    for (const t of result.top) L.push(row(`${t.id.slice(0, 8)} ${t.title}`.slice(0, 32), usd(t.cost)));
  }
  const expired = byCause.get('expired');
  if (expired && expired.usd >= 1) {
    L.push('-'.repeat(W), ...wrap(`Tip: ${usd(expired.usd)} went to rebuilding the cache after long breaks. Run /compact before you step away.`, W, '     '));
  }
  L.push('='.repeat(W), barcode(`week-${days}-${Math.round(sum.cost)}`), '');
  console.log(L.join('\n'));
}

/** @param {string} cwd @param {string} file */
function projectName(cwd, file) {
  const base = path.basename(cwd || '');
  if (base && !base.startsWith('scratch-')) return base;
  return base ? 'no folder (scratch)' : path.basename(path.dirname(file));
}
