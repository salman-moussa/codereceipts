// PostToolUse hook for Bash: trims noisy output before Claude reads it,
// saves the full output to disk, and records the saving in the ledger.
// It must never break a tool call, so every failure exits quietly.
// Only successful commands reach PostToolUse: Claude Code sends failed ones
// to PostToolUseFailure, which cannot replace output, so those stay as they are.
import { trim } from './trim.js';
import { record, saveRaw } from './ledger.js';
import { tokensOf } from './analyze.js';
import { num } from './format.js';

// Claude Code itself cuts Bash output beyond this many characters, so a
// saving is only counted up to what Claude would really have read.
const shownLimit = () => Number(process.env.BASH_MAX_OUTPUT_LENGTH) || 30_000;

/**
 * @param {any} input the hook payload Claude Code sends on stdin
 * @returns {object | null} the hook response, or null to leave the output alone
 */
export function handle(input) {
  if (process.env.TOKENRECEIPTS_TRIM === 'off') return null;
  if (input?.hook_event_name !== 'PostToolUse' || input.tool_name !== 'Bash') return null;
  const resp = input.tool_response;
  if (!resp || typeof resp !== 'object' || resp.isImage) return null;

  const command = String(input.tool_input?.command || '');
  const stdout = typeof resp.stdout === 'string' ? resp.stdout : '';
  const stderr = typeof resp.stderr === 'string' ? resp.stderr : '';
  const out = trim(stdout, command);
  const err = trim(stderr, command);
  if (!out && !err) return null;

  const raw = stderr ? `${stdout}\n--- stderr ---\n${stderr}` : stdout;
  const rawFile = saveRaw(input.session_id, input.tool_use_id, raw);
  if (!rawFile) return null; // another copy of this hook (plugin and settings) already handled it
  const counted = (/** @type {number} */ chars) => tokensOf(Math.min(chars, shownLimit()));
  const rawTokens = counted(stdout.length) + counted(stderr.length);
  const keptTokens = counted(out ? out.keptChars : stdout.length) + counted(err ? err.keptChars : stderr.length);

  record({
    ts: Date.now(),
    session: input.session_id || '',
    agent: input.agent_id || 'main',
    toolUseId: input.tool_use_id || '',
    command: command.slice(0, 160),
    rawTokens,
    keptTokens,
    rawFile,
  });

  const note = `\n[receipts] trimmed ~${num(rawTokens)} -> ~${num(keptTokens)} tokens (errors and warnings kept). Full output: ${rawFile}`;
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: { ...resp, stdout: (out ? out.text : stdout) + note, stderr: err ? err.text : stderr },
    },
  };
}

export async function runHook() {
  try {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    const res = handle(JSON.parse(data));
    if (res) process.stdout.write(JSON.stringify(res));
  } catch {
    // never block the tool call
  }
}
