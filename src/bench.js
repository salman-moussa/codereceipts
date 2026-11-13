// A/B test on your own repo: run the same task with plain Claude Code and
// with each plugin, in throwaway git worktrees, and compare what each arm
// really cost, how many turns it took, and whether your check passed.
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSession, loadSession } from './transcripts.js';
import { analyze } from './analyze.js';
import { readLedger } from './ledger.js';
import { usd, num } from './format.js';

const HELP = `receipts bench - A/B test plugins on your own repo

Usage
  receipts bench --task "<prompt>" [--plugin <dir>]... [options]

Runs the task once per arm in a fresh git worktree of the current repo:
  baseline      plain Claude Code (your user plugins, hooks and MCP servers off)
  <plugin>      the same, plus --plugin-dir <dir>

Options
  --task <text>       the prompt to run (required)
  --plugin <dir>      a plugin to test; repeat for more arms
  --runs <n>          runs per arm (default 1)
  --model <id>        model for every run (default: your Claude Code default)
  --check "<cmd>"     shell command run in the worktree after each run; exit 0 = pass
  --budget <usd>      spend cap per run (default 2)
  --keep              keep the worktrees for inspection
  --json              print raw results

Runs spend real money on your account. Start with a small model and --runs 1.`;

/**
 * @typedef {{ arm: string, run: number, cost: number, turns: number, ms: number, pass: boolean | null, error: string, trimmed: number, hitRate: number }} RunResult
 */

/** @param {string[]} argv */
export async function bench(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: 'string' },
      plugin: { type: 'string', multiple: true },
      runs: { type: 'string' },
      model: { type: 'string' },
      check: { type: 'string' },
      budget: { type: 'string' },
      keep: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || !values.task) return void console.log(HELP);

  const repo = git(['rev-parse', '--show-toplevel'], process.cwd()).trim();
  if (!repo) throw new Error('run bench inside a git repository');
  const runs = Math.max(1, Number(values.runs) || 1);
  const arms = [{ name: 'baseline', plugin: '' }, ...(values.plugin || []).map((p) => ({ name: path.basename(path.resolve(p)), plugin: path.resolve(p) }))];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-bench-'));

  /** @type {RunResult[]} */
  const results = [];
  try {
    for (let r = 1; r <= runs; r++) {
      for (const arm of arms) {
        const dir = path.join(root, `${arm.name}-${r}`);
        git(['worktree', 'add', '--detach', dir, 'HEAD'], repo);
        process.stderr.write(`[${arm.name} ${r}/${runs}] running...`);
        const res = runOnce(dir, /** @type {string} */ (values.task), arm.plugin, values.model, Number(values.budget) || 2);
        const pass = values.check ? spawnSync(values.check, { cwd: dir, shell: true, stdio: 'ignore' }).status === 0 : null;
        const extra = await sessionStats(res.sessionId);
        results.push({ arm: arm.name, run: r, cost: res.cost, turns: res.turns, ms: res.ms, pass, error: res.error, ...extra });
        process.stderr.write(` ${usd(res.cost)}, ${res.turns} turns${pass == null ? '' : pass ? ', check passed' : ', check FAILED'}${res.error ? `, ${res.error}` : ''}\n`);
        if (!values.keep) git(['worktree', 'remove', '--force', dir], repo);
      }
    }
  } finally {
    if (!values.keep) {
      git(['worktree', 'prune'], repo);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  const summary = summarize(results, arms.map((a) => a.name));
  if (values.json) return void console.log(JSON.stringify({ task: values.task, model: values.model || 'default', results, summary }, null, 2));
  console.log(renderBench(summary, /** @type {string} */ (values.task), values.model));
}

/**
 * @param {string} dir @param {string} task @param {string} plugin
 * @param {string | undefined} model @param {number} budget
 */
function runOnce(dir, task, plugin, model, budget) {
  const args = ['-p', task, '--output-format', 'json', '--setting-sources', 'project', '--strict-mcp-config', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash Read Edit Write Grep Glob', '--max-budget-usd', String(budget)];
  if (model) args.push('--model', model);
  if (plugin) args.push('--plugin-dir', plugin);
  const t0 = Date.now();
  const p = spawnSync('claude', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60_000 });
  if (p.error) throw new Error(`could not run claude: ${p.error.message}. Is Claude Code installed and on PATH?`);
  try {
    const out = JSON.parse(p.stdout);
    return { cost: out.total_cost_usd ?? 0, turns: out.num_turns ?? 0, ms: out.duration_ms ?? Date.now() - t0, sessionId: out.session_id || '', error: out.is_error ? String(out.result || out.terminal_reason || 'error').slice(0, 120) : '' };
  } catch {
    return { cost: 0, turns: 0, ms: Date.now() - t0, sessionId: '', error: (p.stderr || 'no output').trim().split('\n')[0].slice(0, 120) };
  }
}

/** @param {string} sessionId */
async function sessionStats(sessionId) {
  const file = sessionId && findSession(sessionId);
  if (!file) return { trimmed: 0, hitRate: 0 };
  const a = analyze(await loadSession(file), readLedger(sessionId));
  return { trimmed: a.trim.savedTokens, hitRate: a.cache.hitRate };
}

/**
 * @param {RunResult[]} results
 * @param {string[]} armNames
 */
export function summarize(results, armNames) {
  return armNames.map((name) => {
    const rs = results.filter((r) => r.arm === name && !r.error);
    const avg = (/** @type {(r: RunResult) => number} */ f) => (rs.length ? rs.reduce((s, r) => s + f(r), 0) / rs.length : 0);
    const checked = rs.filter((r) => r.pass != null);
    return {
      arm: name,
      runs: results.filter((r) => r.arm === name).length,
      ok: rs.length,
      cost: avg((r) => r.cost),
      turns: avg((r) => r.turns),
      seconds: avg((r) => r.ms / 1000),
      passRate: checked.length ? checked.filter((r) => r.pass).length / checked.length : null,
      trimmed: avg((r) => r.trimmed),
      hitRate: avg((r) => r.hitRate),
    };
  });
}

/**
 * @param {ReturnType<typeof summarize>} summary
 * @param {string} task
 * @param {string | undefined} model
 */
export function renderBench(summary, task, model) {
  const base = summary[0];
  const W = 60;
  const L = ['', 'R E C E I P T S   ·   B E N C H', `task:  ${task.slice(0, W - 7)}`, `model: ${model || 'Claude Code default'}`, '='.repeat(W)];
  L.push(`${'arm'.padEnd(16)}${'cost'.padStart(10)}${'vs base'.padStart(10)}${'turns'.padStart(7)}${'time'.padStart(8)}${'check'.padStart(9)}`);
  L.push('-'.repeat(W));
  for (const s of summary) {
    const delta = s === base || !base.cost ? '' : `${s.cost <= base.cost ? '-' : '+'}${Math.round((Math.abs(s.cost - base.cost) / base.cost) * 100)}%`;
    const check = s.passRate == null ? '-' : `${Math.round(s.passRate * 100)}%`;
    L.push(`${s.arm.slice(0, 15).padEnd(16)}${usd(s.cost).padStart(10)}${delta.padStart(10)}${s.turns.toFixed(1).padStart(7)}${`${Math.round(s.seconds)}s`.padStart(8)}${check.padStart(9)}`);
    if (s.trimmed) L.push(`${''.padEnd(16)}trimmed ${num(s.trimmed)} tok per run`);
    if (s.ok < s.runs) L.push(`${''.padEnd(16)}${s.runs - s.ok} run(s) failed and are not averaged`);
  }
  L.push('='.repeat(W), 'Averages per run. Costs are what Claude Code reported. Small samples', 'are noisy: use --runs 3 or more before trusting a difference.', '');
  return L.join('\n');
}

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  const p = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (p.status !== 0 && args[0] !== 'rev-parse') throw new Error(`git ${args.join(' ')}: ${(p.stderr || '').trim()}`);
  return p.status === 0 ? p.stdout : '';
}
