import { usd, num, shortModel } from './format.js';
import { priceFor } from './pricing.js';

const READ_ONLY_AGENTS = /^(explore|scout|search|research|plan|code-explorer)/i;

/**
 * Advice computed from this session's own numbers, most valuable first.
 * Every figure shown is measured; `weight` only ranks the tips.
 * @param {import('./analyze.js').Analysis} a
 * @returns {{ weight: number, text: string }[]}
 */
export function tips(a) {
  /** @type {{ weight: number, text: string }[]} */
  const out = [];
  const lostBy = (/** @type {string} */ cause) => a.cache.misses.filter((m) => m.cause === cause);

  const expired = lostBy('expired');
  const expiredUsd = expired.reduce((s, m) => s + m.lost, 0);
  if (expiredUsd >= 0.05) {
    out.push({
      weight: expiredUsd,
      text: `${usd(expiredUsd)} went to rebuilding the cache after ${expired.length} long break${expired.length > 1 ? 's' : ''}. Run /compact before you step away, or /clear when you start new work.`,
    });
  }

  const changed = lostBy('prefix-changed');
  const changedUsd = changed.reduce((s, m) => s + m.lost, 0);
  if (changedUsd >= 0.05) {
    out.push({
      weight: changedUsd,
      text: `${usd(changedUsd)} lost when the prompt changed mid-session (${changed.length}x). Editing CLAUDE.md or turning MCP servers on and off resets the cache.`,
    });
  }

  const switched = lostBy('model-switch');
  const switchedUsd = switched.reduce((s, m) => s + m.lost, 0);
  if (switchedUsd >= 0.05) {
    out.push({
      weight: switchedUsd,
      text: `${usd(switchedUsd)} lost switching models mid-session. Each model keeps its own cache, so pick one per session.`,
    });
  }

  const readShare = a.totals.cost ? a.totals.costByMeter.read / a.totals.cost : 0;
  if (a.peakContext > 300_000 && readShare > 0.3) {
    out.push({
      weight: a.totals.costByMeter.read * 0.25,
      text: `Context peaked at ${num(a.peakContext)} tokens and cache reads were ${Math.round(readShare * 100)}% of the bill (${usd(a.totals.costByMeter.read)}). Every turn re-reads the whole context: compact earlier or split work into fresh sessions.`,
    });
  }

  const cheapAgents = a.agents.filter((g) => READ_ONLY_AGENTS.test(g.type) && !/haiku/.test(g.model));
  const cheapUsd = cheapAgents.reduce((s, g) => s + g.cost, 0);
  if (cheapAgents.length && cheapUsd >= 0.1) {
    const p = priceFor(cheapAgents[0].model);
    const ratio = p ? Math.round(p.input / 0.1) : 0;
    out.push({
      weight: cheapUsd * 0.8,
      text: `${cheapAgents.length} read-only agent${cheapAgents.length > 1 ? 's' : ''} ran on ${shortModel(cheapAgents[0].model)} (${usd(cheapUsd)}). Search work runs fine on Haiku${ratio > 1 ? `, about ${ratio}x cheaper per token` : ''}.`,
    });
  }

  const bash = a.toolTotals.find((t) => t.tool === 'Bash' || t.tool === 'PowerShell');
  if (bash && bash.tokens > 30_000 && a.trim.events === 0) {
    out.push({
      weight: (bash.tokens / 1e6) * 5,
      text: `Command output put about ${num(bash.tokens)} tokens into context. The Receipts trimmer keeps errors and drops the noise, and saves the full output to disk.`,
    });
  }

  const reread = a.rereads[0];
  if (reread && reread.count >= 4) {
    out.push({
      weight: (reread.tokens / 1e6) * 3,
      text: `${reread.label.split('/').pop()} was read ${reread.count} times (about ${num(reread.tokens)} tokens). Ask for just the part you need.`,
    });
  }

  return out.sort((x, y) => y.weight - x.weight);
}
