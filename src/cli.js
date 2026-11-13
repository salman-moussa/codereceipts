import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { listSessions, loadSession, findSession } from './transcripts.js';
import { analyze } from './analyze.js';
import { readLedger } from './ledger.js';
import { renderReceipt } from './render/receipt.js';
import { usd, num, date } from './format.js';

const HELP = `receipts - what your AI coding sessions really cost, and how to pay less

Usage
  receipts [session]           receipt for the latest (or given) session
  receipts list [-n 15]        recent sessions with their cost
  receipts report [session]    open the Context X-ray page (HTML)
  receipts card [session]      save a shareable receipt card (SVG)
  receipts week [--days 7]     everything you spent across all projects
  receipts bench ...           A/B test a plugin or setting on your own repo
  receipts install             add the live status line and trimmer to Claude Code
  receipts uninstall           remove them again

Options
  --json        print raw numbers instead of the receipt
  --no-color    plain text
  -h, --help    this help

Everything runs locally. Nothing leaves your machine.`;

/** @param {string[]} argv */
export async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      json: { type: 'boolean' },
      'no-color': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      n: { type: 'string', short: 'n' },
      days: { type: 'string' },
      out: { type: 'string', short: 'o' },
      open: { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const [cmd, ...rest] = positionals;

  if (values.help) return void console.log(HELP);
  if (values.version) return void console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);

  switch (cmd) {
    case 'hook':
      return (await import('./hook.js')).runHook();
    case 'statusline':
      return (await import('./statusline.js')).runStatusline();
    case 'list':
      return list(Number(values.n) || 15);
    case 'week':
      return (await import('./week.js')).week({ days: Number(values.days) || 7, json: !!values.json, color: useColor(values) });
    case 'report':
      return (await import('./render/report.js')).writeReport(await load(rest[0]), { out: /** @type {string} */ (values.out), open: !values['no-open'] });
    case 'card':
      return (await import('./render/card.js')).writeCard(await load(rest[0]), { out: /** @type {string} */ (values.out) });
    case 'bench':
      return (await import('./bench.js')).bench(argv.slice(1));
    case 'install':
      return (await import('./install.js')).install();
    case 'uninstall':
      return (await import('./install.js')).uninstall();
    case 'help':
      return void console.log(HELP);
    default: {
      const a = await load(cmd);
      if (values.json) return void console.log(JSON.stringify(a, null, 2));
      console.log(renderReceipt(a, { color: useColor(values) }));
    }
  }
}

/** @param {Record<string, unknown>} values */
function useColor(values) {
  return !values['no-color'] && !process.env.NO_COLOR && !!process.stdout.isTTY;
}

/** @param {string} [idOrPath] */
export async function load(idOrPath) {
  let file;
  if (idOrPath) {
    file = findSession(idOrPath);
    if (!file) throw new Error(`no session matches "${idOrPath}". Try: receipts list`);
  } else {
    file = listSessions()[0]?.file;
    if (!file) throw new Error('no Claude Code sessions found. Run Claude Code once, then try again.');
  }
  const s = await loadSession(file);
  return analyze(s, readLedger(s.id));
}

/** @param {number} n */
async function list(n) {
  const sessions = listSessions().slice(0, n);
  const rows = [];
  for (const s of sessions) {
    const a = analyze(await loadSession(s.file), []);
    rows.push({ id: s.id.slice(0, 8), when: date(a.start), cost: usd(a.totals.cost), calls: num(a.totals.calls), title: a.title.slice(0, 44), folder: path.basename(a.project) });
  }
  const w = (/** @type {string} */ k) => Math.max(...rows.map((r) => String(/** @type {any} */ (r)[k]).length), k.length);
  const cols = ['id', 'when', 'cost', 'calls', 'title'];
  console.log(cols.map((k) => k.toUpperCase().padEnd(w(k))).join('  '));
  for (const r of rows) console.log(cols.map((k) => (k === 'cost' || k === 'calls' ? String(/** @type {any} */ (r)[k]).padStart(w(k)) : String(/** @type {any} */ (r)[k]).padEnd(w(k)))).join('  '));
}
