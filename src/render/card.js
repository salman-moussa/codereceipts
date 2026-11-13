import fs from 'node:fs';
import path from 'node:path';
import { usd, num, dur, date, shortModel, pct, cut } from '../format.js';
import { barcode } from './receipt.js';

const W = 1080;
const H = 1350;
const PAPER_W = 780;
const CHARS = 38;

/** @param {string} s */
const esc = (s) => s.replace(/\p{Cc}/gu, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** @param {string} l @param {string} r @param {number} [chars] */
function row(l, r, chars = CHARS) {
  const room = chars - l.length - r.length - 2;
  if (room < 1) return `${l.slice(0, chars - r.length - 3)}… ${r}`;
  return `${l} ${'.'.repeat(room)} ${r}`;
}

/** Paper outline with zig-zag top and bottom edges, like a torn till roll. */
function paperPath(x0, x1, y0, y1) {
  const pts = [];
  let up = true;
  for (let x = x0; x <= x1; x += 10, up = !up) pts.push([x, up ? y0 : y0 - 10]);
  up = true;
  for (let x = x1; x >= x0; x -= 10, up = !up) pts.push([x, up ? y1 : y1 + 10]);
  return 'M ' + pts.map((p) => p.join(' ')).join(' L ') + ' Z';
}

/**
 * A portrait image (1080x1350) that reads like a till receipt.
 * @param {import('../analyze.js').Analysis} a
 */
export function cardSvg(a) {
  /** @type {{ text: string, kind?: string }[]} */
  const lines = [];
  const add = (/** @type {string} */ text, kind = '') => lines.push({ text, kind });
  const rule = (/** @type {string} */ ch = '-') => add(ch.repeat(CHARS), 'rule');

  add('R E C E I P T S', 'title');
  add('for your AI coding sessions', 'sub');
  rule('=');
  add(row('SESSION', cut(a.title, 24)));
  add(row('DATE', date(a.start).slice(0, 10)));
  add(row('DURATION', dur(a.durationMs)));
  add(row('API CALLS', num(a.totals.calls)));
  rule();
  for (const m of a.byModel.slice(0, 3)) add(row(`${shortModel(m.model)} x${num(m.calls)}`, usd(m.cost)));
  if (a.agents.length) add(row(`incl. ${a.agents.length} subagents`, usd(a.agents.reduce((s, g) => s + g.cost, 0))), 'dim');
  rule('=');
  add(row('TOTAL', usd(a.totals.cost), Math.floor((CHARS * 28) / 33)), 'total');
  rule('=');
  add(row(`Caching saved (${pct(a.cache.hitRate)} hits)`, usd(Math.max(0, a.cache.savedUsd))), 'good');
  if (a.cache.misses.length) add(row(`Lost to ${a.cache.misses.length} cache misses`, usd(a.cache.lostUsd)), 'bad');
  if (a.trim.events) add(row(`Trimmed ${num(a.trim.savedTokens)} tokens`, usd(a.trim.savedUsd)), 'good');
  add(row('Peak context', `${num(a.peakContext)} tok`));
  rule();

  const lineH = 44;
  const top = 150;
  const paperH = lines.length * lineH + 230;
  const x0 = (W - PAPER_W) / 2;
  const x1 = x0 + PAPER_W;
  const y0 = Math.max(70, (H - paperH) / 2 - 30);
  const y1 = y0 + paperH;
  const paper = paperPath(x0, x1, y0, y1);

  const fill = { title: '#111', sub: '#6b6a64', rule: '#b9b7ae', total: '#111', good: '#0b7d0b', bad: '#c0392b', dim: '#6b6a64', '': '#222' };
  const textX = x0 + 48;
  const body = lines
    .map((l, i) => {
      const y = y0 + top - 70 + i * lineH;
      const centered = l.kind === 'title' || l.kind === 'sub';
      const size = l.kind === 'title' ? 40 : l.kind === 'total' ? 33 : 28;
      const weight = l.kind === 'title' || l.kind === 'total' ? 700 : 400;
      return `<text x="${centered ? W / 2 : textX}" y="${y}" ${centered ? 'text-anchor="middle"' : ''} font-size="${size}" font-weight="${weight}" fill="${fill[/** @type {keyof typeof fill} */ (l.kind)]}" xml:space="preserve">${esc(l.text)}</text>`;
    })
    .join('\n  ');
  const by = y0 + top - 70 + lines.length * lineH + 10;
  const bars = barcode(a.id, 37)
    .split('')
    .map((ch, i) => {
      const w = { '▏': 2, '▎': 4, '▍': 6, '▌': 8, '│': 3, ' ': 0 }[ch] || 0;
      return w ? `<rect x="${textX + i * 17}" y="${by}" width="${w}" height="64" fill="#111"/>` : '';
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace">
  <rect width="${W}" height="${H}" fill="#16161a"/>
  <path d="${paper}" fill="#000" opacity="0.35" transform="translate(10 14)"/>
  <path d="${paper}" fill="#fbfaf6"/>
  ${body}
  ${bars}
  <text x="${W / 2}" y="${by + 110}" text-anchor="middle" font-size="24" fill="#6b6a64">${esc(a.id.slice(0, 8))} · list prices · computed locally</text>
  <text x="${W / 2}" y="${H - 44}" text-anchor="middle" font-size="26" fill="#a9a8a2">npx tokenreceipts</text>
</svg>`;
}

/**
 * @param {import('../analyze.js').Analysis} a
 * @param {{ out?: string }} opts
 */
export function writeCard(a, opts = {}) {
  const out = path.resolve(opts.out || `receipt-${a.id.slice(0, 8)}.svg`);
  fs.writeFileSync(out, cardSvg(a));
  console.log(`Saved ${out}`);
  return out;
}
