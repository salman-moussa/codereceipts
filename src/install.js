import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeDir } from './transcripts.js';
import { home } from './ledger.js';

const settingsFile = () => path.join(claudeDir(), 'settings.json');

/** Our own commands, and nothing else: node "<...>/cli/receipts.js" hook|statusline */
const OURS = /^node "[^"]*[\\/]cli[\\/]receipts\.js" (?:hook|statusline)$/;
const isOursCmd = (/** @type {any} */ cmd) => typeof cmd === 'string' && OURS.test(cmd.trim());

/**
 * Copy the CLI to ~/.codereceipts/app so settings never point at an npx
 * cache folder that disappears when the cache is cleared or a new version
 * comes out.
 */
function installApp() {
  const src = fileURLToPath(new URL('..', import.meta.url));
  const dest = path.join(home(), 'app');
  if (path.resolve(src) !== path.resolve(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
    for (const part of ['cli', 'src', 'package.json']) fs.cpSync(path.join(src, part), path.join(dest, part), { recursive: true });
  }
  return path.join(dest, 'cli', 'receipts.js').replace(/\\/g, '/');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return {};
    throw new Error(`could not read ${settingsFile()}: ${/** @type {Error} */ (err).message}. Fix the file and try again.`);
  }
}

/** Keep the first backup forever, then write through a temp file so a crash cannot leave half a file. */
function writeSettings(/** @type {any} */ settings) {
  const file = settingsFile();
  const backup = `${file}.receipts-backup`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.receipts-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** @param {any} settings */
const pluginEnabled = (settings) => Object.entries(settings.enabledPlugins || {}).some(([k, v]) => k.startsWith('codereceipts@') && v);

/** Remove only our hook entries; drop a matcher group only if it held nothing else. */
function stripHooks(/** @type {any[]} */ groups) {
  return groups.flatMap((g) => {
    const before = g.hooks || [];
    const hooks = before.filter((/** @type {any} */ h) => !isOursCmd(h.command));
    if (hooks.length === before.length) return [g];
    return hooks.length ? [{ ...g, hooks }] : [];
  });
}

/**
 * Pure: settings in, settings out. Adds the status line (unless another one
 * is set) and the trimmer hook (unless the plugin already provides it).
 * @param {any} settings
 * @param {string} cli path to cli/receipts.js
 */
export function withReceipts(settings, cli) {
  const s = structuredClone(settings || {});
  const notes = [];
  const cmd = `node "${cli}"`;

  if (!s.statusLine || isOursCmd(s.statusLine.command)) {
    s.statusLine = { type: 'command', command: `${cmd} statusline`, refreshInterval: 5 };
    notes.push('Status line: spend, burn rate, cache countdown, context use.');
  } else {
    notes.push(`Status line: you already have one, so it was left alone. To use Receipts' instead, set statusLine.command to: ${cmd} statusline`);
  }

  if (s.hooks?.PostToolUse) s.hooks.PostToolUse = stripHooks(s.hooks.PostToolUse);
  if (pluginEnabled(s)) {
    notes.push('Trimmer: provided by the Receipts plugin, nothing to add.');
  } else {
    s.hooks ??= {};
    s.hooks.PostToolUse ??= [];
    s.hooks.PostToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: `${cmd} hook`, timeout: 15 }] });
    notes.push('Trimmer: noisy output of successful commands is trimmed, errors kept, full output saved to ~/.codereceipts/raw.');
  }
  return { settings: s, notes };
}

/** @param {any} settings */
export function withoutReceipts(settings) {
  const s = structuredClone(settings || {});
  if (isOursCmd(s.statusLine?.command)) delete s.statusLine;
  if (s.hooks?.PostToolUse) {
    s.hooks.PostToolUse = stripHooks(s.hooks.PostToolUse);
    if (!s.hooks.PostToolUse.length) delete s.hooks.PostToolUse;
    if (!Object.keys(s.hooks).length) delete s.hooks;
  }
  return s;
}

export function install() {
  const { settings, notes } = withReceipts(readSettings(), installApp());
  writeSettings(settings);
  console.log(`Updated ${settingsFile()} (your original is kept in settings.json.receipts-backup)\n`);
  for (const n of notes) console.log(`  - ${n}`);
  console.log('\nRestart Claude Code to see it. Turn the trimmer off any time with CODERECEIPTS_TRIM=off.');
}

export function uninstall() {
  writeSettings(withoutReceipts(readSettings()));
  console.log(`Removed Receipts from ${settingsFile()}.`);
}
