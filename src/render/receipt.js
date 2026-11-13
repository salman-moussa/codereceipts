import { usd, num, dur, date, shortModel, pct, CAUSE_TEXT } from '../format.js';
import { tips } from '../tips.js';

const W = 46;

/** @param {boolean} color */
function painter(color) {
  const wrap = (/** @type {string} */ a, /** @type {string} */ b) => (/** @type {string} */ s) => (color ? `\x1b[${a}m${s}\x1b[${b}m` : s);
  return { bold: wrap('1', '22'), dim: wrap('2', '22'), green: wrap('32', '39'), red: wrap('31', '39'), yellow: wrap('33', '39') };
}

/** Left text and right text on one line, dotted in between. */
function row(left, right, width = W) {
  const l = String(left);
  const r = String(right);
  const room = width - l.length - r.length - 2;
  if (room < 1) return `${l.slice(0, width - r.length - 3)}… ${r}`;
  return `${l} ${'.'.repeat(room)} ${r}`;
}

const center = (/** @type {string} */ s) => ' '.repeat(Math.max(0, Math.floor((W - s.length) / 2))) + s;
const rule = (ch = '-') => ch.repeat(W);

/** A barcode drawn from the session id, so every receipt has its own. */
export function barcode(id, width = W) {
  const bars = ['▏', '▎', '▍', '▌', '│', ' '];
  let h = 2166136261;
  let out = '';
  for (let i = 0; i < width; i++) {
    h = Math.imul(h ^ id.charCodeAt(i % id.length), 16777619) >>> 0;
    out += bars[h % bars.length];
  }
  return out;
}

/**
 * The receipt printed in the terminal.
 * @param {import('../analyze.js').Analysis} a
 * @param {{ color?: boolean }} [opts]
 */
export function renderReceipt(a, opts = {}) {
  const c = painter(opts.color ?? false);
  const L = [];
  const t = a.totals;

  L.push('', center(c.bold('R E C E I P T S')), center(c.dim('for your AI coding sessions')), rule('='));
  L.push(row('SESSION', a.title.slice(0, 30)));
  if (a.project) L.push(row('FOLDER', a.project.slice(0, 30)));
  L.push(row('STARTED', date(a.start)), row('DURATION', dur(a.durationMs)), row('API CALLS', num(t.calls)), rule());

  for (const m of a.byModel.slice(0, 5)) L.push(row(`${shortModel(m.model)}  x${num(m.calls)}`, usd(m.cost)));
  if (a.agents.length) {
    L.push(rule());
    L.push(row('Main conversation', usd(a.mainCost)));
    const agentUsd = a.agents.reduce((s, g) => s + g.cost, 0);
    L.push(row(`${a.agents.length} subagent${a.agents.length > 1 ? 's' : ''}`, usd(agentUsd)));
    for (const g of a.agents.slice(0, 3)) L.push(c.dim(row(`  ${g.description || g.type}`.slice(0, 32), usd(g.cost))));
  }

  L.push(rule());
  L.push(row(`Output  ${num(t.output)} tok`, usd(t.costByMeter.output)));
  L.push(row(`Cache writes  ${num(t.write)} tok`, usd(t.costByMeter.write)));
  L.push(row(`Cache reads  ${num(t.read)} tok`, usd(t.costByMeter.read)));
  L.push(row(`Fresh input  ${num(t.input)} tok`, usd(t.costByMeter.input)));
  L.push(rule('='));
  L.push(c.bold(row('TOTAL', usd(t.cost))));
  L.push(rule('='));

  L.push(c.green(row(`Caching saved you (${pct(a.cache.hitRate)} hits)`, usd(Math.max(0, a.cache.savedUsd)))));
  if (a.cache.misses.length) {
    L.push(c.red(row('Lost to cache misses', usd(a.cache.lostUsd))));
    /** @type {Record<string, { n: number, usd: number }>} */
    const by = {};
    for (const m of a.cache.misses) {
      by[m.cause] ??= { n: 0, usd: 0 };
      by[m.cause].n++;
      by[m.cause].usd += m.lost;
    }
    for (const [cause, v] of Object.entries(by).sort((x, y) => y[1].usd - x[1].usd)) {
      L.push(c.dim(row(`  ${v.n}x ${CAUSE_TEXT[/** @type {keyof typeof CAUSE_TEXT} */ (cause)] || cause}`, usd(v.usd))));
    }
  }
  if (a.trim.events) {
    L.push(c.green(row(`Trimmed ${num(a.trim.savedTokens)} tok (${a.trim.events}x)`, usd(a.trim.savedUsd))));
    L.push(c.dim('  counts every later turn that skipped them'));
  }
  if (a.compactions.length) L.push(row('Compactions', String(a.compactions.length)));
  L.push(row('Peak context', `${num(a.peakContext)} tok`));

  if (a.eaters.length) {
    L.push(rule(), c.bold('WHAT FILLED THE CONTEXT'));
    for (const e of a.eaters.slice(0, 5)) {
      const name = e.tool.startsWith('mcp__') ? e.tool.split('__').slice(1).join(':') : e.tool;
      const label = e.label === e.tool ? name : `${name} ${e.label}`;
      L.push(row(`${label.slice(0, 30)}${e.count > 1 ? ` x${e.count}` : ''}`, `${num(e.tokens)}`));
    }
  }

  const advice = tips(a).slice(0, 3);
  if (advice.length) {
    L.push(rule(), c.bold('HOW TO PAY LESS NEXT TIME'));
    for (const tip of advice) L.push(...wrap(`- ${tip.text}`, W, '  '));
  }

  L.push(rule('='), c.dim(barcode(a.id)), center(c.dim(a.id.slice(0, 8) + '  ·  list prices, local data only')), '');
  return L.join('\n');
}

/** @param {string} text @param {number} width @param {string} indent */
export function wrap(text, width, indent = '') {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > width && line) {
      lines.push(line);
      line = indent + w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}
