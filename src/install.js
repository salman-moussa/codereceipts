import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeDir } from './transcripts.js';

const MARK = 'receipts.js';
const cliPath = () => fileURLToPath(new URL('../cli/receipts.js', import.meta.url)).replace(/\\/g, '/');
const settingsFile = () => path.join(claudeDir(), 'settings.json');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return {};
    throw new Error(`could not read ${settingsFile()}: ${/** @type {Error} */ (err).message}. Fix the file and try again.`);
  }
}

/** @param {any} settings */
function writeSettings(settings) {
  const file = settingsFile();
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.receipts-backup`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

/** @param {any} settings */
const pluginEnabled = (settings) => Object.entries(settings.enabledPlugins || {}).some(([k, v]) => k.startsWith('tokenreceipts@') && v);

/** @param {any} entry */
const isOurs = (entry) => JSON.stringify(entry || '').includes(MARK);

/**
 * Pure: settings in, settings out. Adds the status line (unless another one
 * is set) and the trimmer hook (unless the plugin already provides it).
 * @param {any} settings
 * @param {string} cli
 */
export function withReceipts(settings, cli) {
  const s = structuredClone(settings || {});
  const notes = [];
  const cmd = `node "${cli}"`;

  if (!s.statusLine || isOurs(s.statusLine)) {
    s.statusLine = { type: 'command', command: `${cmd} statusline`, refreshInterval: 5 };
    notes.push('Status line: spend, burn rate, cache countdown, context use.');
  } else {
    notes.push(`Status line: you already have one, so it was left alone. To use Receipts' instead, set statusLine.command to: ${cmd} statusline`);
  }

  if (pluginEnabled(s)) {
    notes.push('Trimmer: provided by the Receipts plugin, nothing to add.');
  } else {
    s.hooks ??= {};
    s.hooks.PostToolUse ??= [];
    s.hooks.PostToolUse = s.hooks.PostToolUse.filter((/** @type {any} */ m) => !isOurs(m));
    s.hooks.PostToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: `${cmd} hook`, timeout: 15 }] });
    notes.push('Trimmer: noisy command output is trimmed, errors kept, full output saved to ~/.tokenreceipts/raw.');
  }
  return { settings: s, notes };
}

/** @param {any} settings */
export function withoutReceipts(settings) {
  const s = structuredClone(settings || {});
  if (isOurs(s.statusLine)) delete s.statusLine;
  if (s.hooks?.PostToolUse) {
    s.hooks.PostToolUse = s.hooks.PostToolUse.filter((/** @type {any} */ m) => !isOurs(m));
    if (!s.hooks.PostToolUse.length) delete s.hooks.PostToolUse;
    if (!Object.keys(s.hooks).length) delete s.hooks;
  }
  return s;
}

export function install() {
  const { settings, notes } = withReceipts(readSettings(), cliPath());
  writeSettings(settings);
  console.log(`Updated ${settingsFile()} (backup: settings.json.receipts-backup)\n`);
  for (const n of notes) console.log(`  - ${n}`);
  console.log('\nRestart Claude Code to see it. Turn the trimmer off any time with TOKENRECEIPTS_TRIM=off.');
}

export function uninstall() {
  writeSettings(withoutReceipts(readSettings()));
  console.log(`Removed Receipts from ${settingsFile()} (backup: settings.json.receipts-backup).`);
}
