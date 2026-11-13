import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TOKENRECEIPTS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-test-'));

const { trim, classify } = await import('../src/trim.js');
const { handle } = await import('../src/hook.js');
const { readLedger } = await import('../src/ledger.js');
const { render } = await import('../src/statusline.js');
const { withReceipts, withoutReceipts } = await import('../src/install.js');
const { summarize, renderBench } = await import('../src/bench.js');

function testLog() {
  let s = '';
  for (let i = 0; i < 300; i++) s += `\x1b[32m✔\x1b[0m renders card ${i} (${i % 9}ms)\n`;
  s += '✖ total includes tax\n  AssertionError: 100 !== 110\n    at cart.test.js:5:41\n';
  for (let i = 0; i < 80; i++) s += `✔ formats price ${i}\n`;
  return s + 'ℹ fail 1\n';
}

test('trim: collapses passing tests, keeps every failure line, strips colors', () => {
  const r = trim(testLog(), 'npm test');
  assert.ok(r);
  assert.ok(r.keptChars < r.rawChars * 0.2, 'big saving');
  assert.match(r.text, /total includes tax/);
  assert.match(r.text, /AssertionError: 100 !== 110/);
  assert.match(r.text, /at cart\.test\.js:5:41/);
  assert.match(r.text, /similar lines/);
  assert.doesNotMatch(r.text, /\x1b\[/);
});

test('trim: leaves deliberate reads, quiet commands and small output alone', () => {
  assert.equal(trim(testLog(), 'cat build.log'), null);
  assert.equal(trim(testLog(), 'git diff HEAD~3'), null);
  assert.equal(trim(testLog(), 'ls -la'), null, 'not noisy and not huge');
  assert.equal(trim('short output', 'npm test'), null);
  assert.ok(trim('line\n'.repeat(20000), 'some-script'), 'huge output from any command');
});

test('trim: Windows line endings keep every line, progress redraws keep the last state', () => {
  let s = '';
  for (let i = 0; i < 400; i++) s += `PASS test ${i}\r\n`;
  s += 'FAIL checkout total\r\nDownloading 10%\rDownloading 100%\r\n';
  const r = trim(s, 'dotnet test');
  assert.ok(r);
  assert.match(r.text, /FAIL checkout total/);
  assert.match(r.text, /Downloading 100%/);
  assert.doesNotMatch(r.text, /Downloading 10%/);
});

test('trim: a command is classified by each of its parts, not by words inside it', () => {
  const big = 'x\n'.repeat(40_000);
  assert.deepEqual(classify('grep -rn webpack src/'), { read: true, noisy: false });
  assert.equal(classify('cd src && cat big.js').read, true);
  assert.equal(trim(big, 'cd src && cat big.js'), null, 'a read is never trimmed, however big');
  assert.equal(classify('npm test | grep FAIL').read, true, 'already filtered by the user');
  assert.equal(classify('CI=1 npx jest --ci').noisy, true);
  assert.equal(classify('cd app && pnpm run build').noisy, true);
  assert.equal(classify('git log -p').read, true);
  assert.equal(classify('echo webpack').noisy, false);
});

test('trim: long logs keep head, tail and errors with context', () => {
  const lines = [];
  for (let i = 0; i < 2000; i++) lines.push(`${Math.random().toString(36).slice(2, 10)} step ${i}`);
  lines[1200] = 'ERROR: database connection refused';
  const r = trim(lines.join('\n'), 'docker compose logs api');
  assert.ok(r);
  assert.match(r.text, /database connection refused/);
  assert.match(r.text, /lines omitted/);
  assert.match(r.text, /step 1999/);
});

test('hook: replaces Bash output in the same shape, records the saving once', () => {
  const input = {
    session_id: 'hook-test',
    tool_use_id: 'toolu_x',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_response: { stdout: testLog(), stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
  };
  const res = /** @type {any} */ (handle(input));
  const out = res.hookSpecificOutput.updatedToolOutput;
  assert.equal(res.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.deepEqual(Object.keys(out), Object.keys(input.tool_response));
  assert.match(out.stdout, /\[receipts\] trimmed/);
  const [ev] = readLedger('hook-test');
  assert.ok(ev.rawTokens > ev.keptTokens);
  assert.equal(fs.readFileSync(ev.rawFile, 'utf8'), testLog(), 'full output saved');
  assert.equal(handle(input), null, 'second copy of the hook does nothing');
  assert.equal(handle({ ...input, tool_name: 'Read' }), null);
  assert.equal(handle({ ...input, tool_use_id: 'toolu_y', tool_response: { stdout: 'ok', stderr: '' } }), null);
});

test('statusline: warm countdown, cold warning with rebuild cost', () => {
  const now = 1_000_000;
  const base = { cost: { total_cost_usd: 2.5, total_duration_ms: 3_600_000 }, model: { id: 'claude-opus-5-5' }, context_window: { used_percentage: 42 } };
  const warm = render({ ...base, prompt_cache: { caching_observed: true, warm: true, ttl: '5m', expires_at: now + 200, hit_ratio: 0.93, recache_tokens_if_cold: 500_000, misses: 1 } }, [], now);
  assert.match(warm, /\$2\.50/);
  assert.match(warm, /\$2\.50\/h|2\.50/);
  assert.match(warm, /warm 3:20/);
  assert.match(warm, /cold costs \$2\.40/);
  assert.match(warm, /ctx 42%/);
  const cold = render({ ...base, prompt_cache: { caching_observed: true, warm: false, ttl: '5m', recache_tokens_if_cold: 500_000 } }, [{ ts: 0, session: 's', agent: 'main', toolUseId: 't', command: '', rawTokens: 5000, keptTokens: 500, rawFile: '' }], now);
  assert.match(cold, /next turn \+\$2\.40/);
  assert.match(cold, /trimmed 4\.5K tok/);
});

test('install: adds status line and hook, keeps a foreign status line, uninstalls cleanly', () => {
  const fresh = withReceipts({}, '/x/cli/receipts.js').settings;
  assert.match(fresh.statusLine.command, /receipts\.js" statusline/);
  assert.equal(fresh.hooks.PostToolUse.length, 1);
  const again = withReceipts(fresh, '/x/cli/receipts.js').settings;
  assert.equal(again.hooks.PostToolUse.length, 1, 'idempotent');

  const mine = { statusLine: { type: 'command', command: 'my-line.sh' }, hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [] }] } };
  const kept = withReceipts(mine, '/x/cli/receipts.js').settings;
  assert.equal(kept.statusLine.command, 'my-line.sh');
  assert.equal(kept.hooks.PostToolUse.length, 2);
  assert.deepEqual(withoutReceipts(kept), mine);

  const viaPlugin = withReceipts({ enabledPlugins: { 'tokenreceipts@tokenreceipts': true } }, '/x').settings;
  assert.equal(viaPlugin.hooks, undefined, 'plugin already provides the hook');
});

test('install: removes only its own hook, never a user hook in the same group or with a similar name', () => {
  const userHook = { type: 'command', command: 'node ./scripts/receipts.js --mine' };
  const shared = { matcher: 'Bash', hooks: [userHook, { type: 'command', command: 'node "/x/cli/receipts.js" hook', timeout: 15 }] };
  const out = withoutReceipts({ hooks: { PostToolUse: [shared] }, statusLine: { type: 'command', command: 'node ./receipts.js' } });
  assert.deepEqual(out.hooks.PostToolUse, [{ matcher: 'Bash', hooks: [userHook] }]);
  assert.equal(out.statusLine.command, 'node ./receipts.js', 'a foreign status line stays');
  const kept = withReceipts({ statusLine: { type: 'command', command: 'node ./receipts.js' } }, '/x/cli/receipts.js').settings;
  assert.equal(kept.statusLine.command, 'node ./receipts.js');
});

test('bench: averages per arm, ignores failed runs, shows delta vs baseline', () => {
  const runs = [
    { arm: 'baseline', run: 1, cost: 0.2, turns: 6, ms: 30000, pass: true, error: '', trimmed: 0, hitRate: 0.8 },
    { arm: 'baseline', run: 2, cost: 0.4, turns: 8, ms: 50000, pass: false, error: '', trimmed: 0, hitRate: 0.8 },
    { arm: 'tokenreceipts', run: 1, cost: 0.15, turns: 5, ms: 25000, pass: true, error: '', trimmed: 3000, hitRate: 0.9 },
    { arm: 'tokenreceipts', run: 2, cost: 0, turns: 0, ms: 1000, pass: null, error: 'auth', trimmed: 0, hitRate: 0 },
  ];
  const s = summarize(runs, ['baseline', 'tokenreceipts']);
  assert.equal(s[0].cost, 0.30000000000000004);
  assert.equal(s[0].passRate, 0.5);
  assert.equal(s[1].ok, 1);
  assert.equal(s[1].cost, 0.15);
  const out = renderBench(s, 'fix the bug', 'haiku');
  assert.match(out, /-50%/);
  assert.match(out, /1 run\(s\) failed/);
});
