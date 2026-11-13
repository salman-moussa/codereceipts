import path from 'node:path';
import { costOf, missPenalty, readCost, writeCost } from './pricing.js';

/** Rough token estimate for text we can see. Anthropic tokenizers average ~4 chars per token on code and logs. */
export const tokensOf = (/** @type {number} */ chars) => Math.round(chars / 4);

const MIN_PROMPT_FOR_MISS = 8000;
const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 };

/**
 * Turn a parsed session into everything the receipt, report and card show.
 * @param {import('./transcripts.js').Session} s
 * @param {import('./ledger.js').TrimEvent[]} [trims]
 */
export function analyze(s, trims = []) {
  const totals = { cost: 0, input: 0, output: 0, read: 0, write: 0, noCache: 0, calls: 0, unknownCalls: 0, costByMeter: { input: 0, output: 0, read: 0, write: 0 } };
  /** @type {Map<string, { model: string, calls: number, cost: number }>} */
  const byModel = new Map();
  /** @type {Map<string, { id: string, type: string, description: string, model: string, calls: number, cost: number }>} */
  const byAgent = new Map();
  const agentInfo = new Map(s.agents.map((a) => [a.id, a]));

  for (const c of s.calls) {
    const u = c.usage;
    const k = costOf(u, c.model);
    /** @type {any} */ (c).cost = k;
    totals.calls++;
    if (!k.known) totals.unknownCalls++;
    totals.cost += k.total;
    totals.noCache += k.noCache;
    totals.input += u.input_tokens ?? 0;
    totals.output += u.output_tokens ?? 0;
    totals.read += u.cache_read_input_tokens ?? 0;
    totals.write += u.cache_creation_input_tokens ?? 0;
    totals.costByMeter.input += k.input;
    totals.costByMeter.output += k.output;
    totals.costByMeter.read += k.read;
    totals.costByMeter.write += k.write;

    const m = byModel.get(c.model) || { model: c.model, calls: 0, cost: 0 };
    m.calls++;
    m.cost += k.total;
    byModel.set(c.model, m);

    if (c.agent !== 'main') {
      const info = agentInfo.get(c.agent);
      const a = byAgent.get(c.agent) || { id: c.agent, type: info?.type || 'subagent', description: info?.description || '', model: c.model, calls: 0, cost: 0 };
      a.calls++;
      a.cost += k.total;
      byAgent.set(c.agent, a);
    }
  }

  const main = s.calls.filter((c) => c.agent === 'main');
  const mainCompactions = s.compactions.filter((c) => c.agent === 'main');

  // Context timeline and cache-miss forensics for the main conversation.
  /** @type {{ ts: number, context: number, read: number, write: number, input: number, output: number, cost: number, cum: number, model: string, miss: string | null }[]} */
  const timeline = [];
  /** @type {{ ts: number, model: string, tokens: number, cause: string, lost: number, gapMs: number }[]} */
  const misses = [];
  let ttl = /** @type {'5m' | '1h'} */ ('5m');
  let cum = 0;
  main.forEach((c, i) => {
    const u = c.usage;
    const read = u.cache_read_input_tokens ?? 0;
    const write = u.cache_creation_input_tokens ?? 0;
    const input = u.input_tokens ?? 0;
    const prompt = input + read + write;
    const cost = /** @type {any} */ (c).cost.total;
    cum += cost;
    /** @type {string | null} */
    let miss = null;
    if (i > 0) {
      const p = main[i - 1];
      const pu = p.usage;
      const prevPrompt = (pu.input_tokens ?? 0) + (pu.cache_read_input_tokens ?? 0) + (pu.cache_creation_input_tokens ?? 0);
      if (prevPrompt > MIN_PROMPT_FOR_MISS && read < prevPrompt * 0.5) {
        const gapMs = c.ts - p.ts;
        const lostTokens = Math.min(prevPrompt, prompt) - read;
        if (mainCompactions.some((x) => x.ts > p.ts && x.ts <= c.ts)) miss = 'compaction';
        else if (gapMs > TTL_MS[ttl] * 0.95) miss = 'expired';
        else if (c.model !== p.model) miss = 'model-switch';
        else miss = 'prefix-changed';
        if (lostTokens > 0) {
          const lost = miss === 'compaction' ? 0 : missPenalty(lostTokens, c.model, ttl);
          misses.push({ ts: c.ts, model: c.model, tokens: lostTokens, cause: miss, lost, gapMs });
        }
      }
    }
    if ((u.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0) ttl = '1h';
    timeline.push({ ts: c.ts, context: prompt, read, write, input, output: u.output_tokens ?? 0, cost, cum, model: c.model, miss });
  });

  // What filled the context: tool results in the main conversation.
  /** @type {Map<string, { name: string, input: any }>} */
  const tools = new Map();
  for (const c of s.calls) for (const t of c.toolUses) tools.set(t.id, t);
  /** @type {Map<string, { tool: string, label: string, tokens: number, count: number }>} */
  const eat = new Map();
  for (const r of s.results) {
    if (r.agent !== 'main') continue;
    const t = tools.get(r.toolUseId);
    const tool = t?.name || 'tool';
    const label = labelFor(tool, t?.input, s.cwd);
    const key = `${tool}|${label}`;
    const e = eat.get(key) || { tool, label, tokens: 0, count: 0 };
    e.tokens += tokensOf(r.chars);
    e.count++;
    eat.set(key, e);
  }
  const eaters = [...eat.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 10);
  const rereads = [...eat.values()].filter((e) => e.tool === 'Read' && e.count > 2).sort((a, b) => b.count - a.count).slice(0, 5);
  const toolTotals = new Map();
  for (const e of eat.values()) toolTotals.set(e.tool, (toolTotals.get(e.tool) || 0) + e.tokens);

  // Receipts trimmer savings, with compounding: a token kept out of the
  // context early is not re-read by any later call until the next compaction.
  const trim = { events: 0, rawTokens: 0, keptTokens: 0, savedTokens: 0, savedUsd: 0, firstPassUsd: 0 };
  for (const ev of trims) {
    const saved = Math.max(0, ev.rawTokens - ev.keptTokens);
    trim.events++;
    trim.rawTokens += ev.rawTokens;
    trim.keptTokens += ev.keptTokens;
    trim.savedTokens += saved;
    const agent = ev.agent && s.calls.some((c) => c.agent === ev.agent) ? ev.agent : 'main';
    const nextCompaction = s.compactions.filter((x) => x.agent === agent && x.ts > ev.ts).map((x) => x.ts).sort((a, b) => a - b)[0] ?? Infinity;
    const later = s.calls.filter((c) => c.agent === agent && c.ts > ev.ts && c.ts < nextCompaction);
    if (!later.length) continue;
    const first = writeCost(saved, later[0].model, ttl);
    trim.firstPassUsd += first;
    trim.savedUsd += first + later.slice(1).reduce((sum, c) => sum + readCost(saved, c.model), 0);
  }

  const all = [...s.calls.map((c) => c.ts), ...s.results.map((r) => r.ts)].filter(Boolean);
  const start = all.length ? Math.min(...all) : 0;
  const end = all.length ? Math.max(...all) : 0;
  const promptTokens = totals.input + totals.read + totals.write;
  const lostToMisses = misses.reduce((sum, m) => sum + m.lost, 0);

  const whatIf = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map((model) => ({
    model,
    cost: s.calls.reduce((sum, c) => sum + costOf(c.usage, model).total, 0),
  }));

  return {
    id: s.id,
    title: s.title,
    project: path.basename(s.cwd || '') || '',
    start,
    end,
    durationMs: end - start,
    totals,
    byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost),
    mainCost: main.reduce((sum, c) => sum + /** @type {any} */ (c).cost.total, 0),
    mainCalls: main.length,
    agents: [...byAgent.values()].sort((a, b) => b.cost - a.cost),
    cache: {
      hitRate: promptTokens ? totals.read / promptTokens : 0,
      savedUsd: totals.noCache - totals.cost,
      misses,
      lostUsd: lostToMisses,
      ttl,
    },
    compactions: s.compactions,
    timeline,
    eaters,
    rereads,
    toolTotals: [...toolTotals.entries()].map(([tool, tokens]) => ({ tool, tokens })).sort((a, b) => b.tokens - a.tokens),
    trim,
    whatIf,
    peakContext: timeline.reduce((m, t) => Math.max(m, t.context), 0),
  };
}

/** @typedef {ReturnType<typeof analyze>} Analysis */

/**
 * @param {string} tool
 * @param {any} input
 * @param {string} cwd
 */
export function labelFor(tool, input, cwd) {
  if (!input) return tool;
  const rel = (/** @type {string} */ p) => {
    if (!p) return '';
    const r = (cwd ? path.relative(cwd, p) : p).replace(/\\/g, '/');
    if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r;
    const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : parts.join('/');
  };
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return rel(input.file_path || input.notebook_path);
    case 'Bash':
    case 'PowerShell':
      return String(input.command || '').split('\n')[0].trim().slice(0, 70);
    case 'Grep':
      return `"${String(input.pattern || '').slice(0, 40)}"`;
    case 'Glob':
      return String(input.pattern || '');
    case 'WebFetch':
      return String(input.url || '').replace(/^https?:\/\//, '').slice(0, 60);
    case 'WebSearch':
      return String(input.query || '').slice(0, 60);
    case 'Agent':
    case 'Task':
      return String(input.description || input.subagent_type || 'agent');
    default:
      return tool;
  }
}
