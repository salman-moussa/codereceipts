// Live status line for Claude Code. Shows spend, burn rate, how long the
// prompt cache stays warm, and what the next turn costs if it goes cold.
import { readLedger } from './ledger.js';
import { missPenalty } from './pricing.js';
import { usd, num } from './format.js';

const color = !process.env.NO_COLOR;
const paint = (/** @type {string} */ code, /** @type {string} */ s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (/** @type {string} */ s) => paint('2', s);
const green = (/** @type {string} */ s) => paint('32', s);
const yellow = (/** @type {string} */ s) => paint('33', s);
const red = (/** @type {string} */ s) => paint('31', s);

/** @param {number} sec */
function clock(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * @param {any} input statusline JSON from Claude Code
 * @param {import('./ledger.js').TrimEvent[]} trims this session's trims
 * @param {number} now epoch seconds
 */
export function render(input, trims, now) {
  const parts = [];
  const cost = input?.cost?.total_cost_usd ?? 0;
  const ms = input?.cost?.total_duration_ms ?? 0;
  const perHour = ms > 60_000 ? (cost / ms) * 3_600_000 : 0;
  parts.push(`${usd(cost)}${perHour ? dim(` ${usd(perHour)}/h`) : ''}`);

  const pc = input?.prompt_cache;
  if (pc && pc.caching_observed) {
    const hit = pc.hit_ratio == null ? '' : `${Math.round(pc.hit_ratio * 100)}% `;
    const model = input?.model?.id;
    const rebuild = pc.recache_tokens_if_cold ? missPenalty(pc.recache_tokens_if_cold, model, pc.ttl) : 0;
    const left = pc.expires_at ? pc.expires_at - now : 0;
    let cache = `cache ${hit}`;
    if (pc.warm && left > 0) {
      const t = `warm ${clock(left)}`;
      cache += left < 90 ? yellow(t) : green(t);
      if (rebuild >= 0.01) cache += dim(` · cold costs ${usd(rebuild)}`);
    } else if (rebuild >= 0.01) {
      cache += red(`cold · next turn +${usd(rebuild)}`);
    } else cache += dim('cold');
    if (pc.misses) cache += dim(` · ${pc.misses} miss${pc.misses > 1 ? 'es' : ''}`);
    parts.push(cache);
  }

  const used = input?.context_window?.used_percentage;
  if (typeof used === 'number') {
    const t = `ctx ${Math.round(used)}%`;
    parts.push(used >= 80 ? red(t) : used >= 50 ? yellow(t) : t);
  }

  const saved = trims.reduce((s, t) => s + Math.max(0, t.rawTokens - t.keptTokens), 0);
  if (saved) parts.push(green(`trimmed ${num(saved)} tok`));

  return parts.join(dim(' │ '));
}

export async function runStatusline() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  let input = {};
  try {
    input = JSON.parse(data);
  } catch {
    /* render what we can */
  }
  const trims = /** @type {any} */ (input).session_id ? readLedger(/** @type {any} */ (input).session_id) : [];
  process.stdout.write(render(input, trims, Date.now() / 1000));
}
