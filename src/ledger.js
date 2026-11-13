import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function home() {
  return process.env.CODERECEIPTS_HOME || path.join(os.homedir(), '.codereceipts');
}

const ledgerFile = () => path.join(home(), 'ledger.jsonl');

/**
 * @typedef {object} TrimEvent
 * @property {number} ts
 * @property {string} session
 * @property {string} agent
 * @property {string} toolUseId
 * @property {string} command
 * @property {number} rawTokens
 * @property {number} keptTokens
 * @property {string} rawFile
 */

/** @param {TrimEvent} ev */
export function record(ev) {
  fs.mkdirSync(home(), { recursive: true });
  fs.appendFileSync(ledgerFile(), JSON.stringify(ev) + '\n');
}

/**
 * @param {string} [session] only events for this session
 * @returns {TrimEvent[]}
 */
export function readLedger(session) {
  let text = '';
  try {
    text = fs.readFileSync(ledgerFile(), 'utf8');
  } catch {
    return [];
  }
  /** @type {TrimEvent[]} */
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (!session || ev.session === session) out.push(ev);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

/** Save the untrimmed output so nothing is lost: Claude can read it back. */
export function saveRaw(session, toolUseId, text) {
  const file = rawPath(session, toolUseId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    // 'wx' fails if the file exists: when two copies of the hook run at once, only one wins.
    fs.writeFileSync(file, text, { flag: 'wx' });
  } catch (err) {
    if (/** @type {any} */ (err).code === 'EEXIST') return null;
    throw err;
  }
  return file;
}

/** Where the full output of one tool call is kept. */
export function rawPath(session, toolUseId) {
  const safe = (/** @type {string} */ s) => String(s || '').replace(/[^\w-]/g, '_');
  return path.join(home(), 'raw', safe(session) || 'unknown', `${safe(toolUseId) || Date.now()}.txt`);
}
