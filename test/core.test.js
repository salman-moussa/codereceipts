import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TOKENRECEIPTS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-test-'));

const { costOf, priceFor, missPenalty } = await import('../src/pricing.js');
const { loadSession } = await import('../src/transcripts.js');
const { analyze, labelFor } = await import('../src/analyze.js');
const { tips } = await import('../src/tips.js');
const { renderReceipt } = await import('../src/render/receipt.js');

const fixture = fileURLToPath(new URL('./fixtures/fx.jsonl', import.meta.url));
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);

test('pricing: four meters at list price, cache writes 1.25x / 2x', () => {
  const c = costOf({ input_tokens: 10, cache_creation_input_tokens: 20000, output_tokens: 150, cache_creation: { ephemeral_5m_input_tokens: 20000 } }, 'claude-opus-5-5');
  close(c.total, 0.00004 + 0.1 + 0.003, 'opus 5.5 call');
  const h = costOf({ cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 1000 } }, 'claude-opus-5-5');
  close(h.write, (1000 * 4 * 2) / 1e6, '1h write');
  close(costOf({ cache_read_input_tokens: 1e6 }, 'claude-sonnet-5-5').read, 0.1, 'sonnet 5.5 read');
});

test('pricing: fast mode doubles, unknown models are flagged, prefixes resolve', () => {
  close(costOf({ output_tokens: 1e6, speed: 'fast' }, 'claude-opus-5-5').total, 40, 'fast output');
  assert.equal(costOf({ output_tokens: 5 }, 'gpt-x').known, false);
  assert.equal(priceFor('claude-opus-5')?.read, 0.5);
  assert.equal(priceFor('claude-opus-5-5')?.read, 0.2);
  assert.equal(priceFor('us.anthropic.claude-sonnet-4-6')?.input, 3);
  close(costOf({ input_tokens: 200_000 }, 'claude-haiku-5-5').input, 0.1, 'haiku long-context tier');
  close(missPenalty(1e6, 'claude-opus-5-5', '5m'), 4.8, 'miss penalty');
  close(missPenalty(200_000, 'claude-haiku-5-5', '5m', { prompt: 200_000 }), 0.115, 'long-context miss');
  close(missPenalty(1e6, 'claude-opus-5-5', '5m', { fast: true }), 9.6, 'fast-mode miss');
  assert.equal(priceFor('claude-fable-5-20261101')?.input, 10, 'dated id is not the next version');
});

test('titles are cut by character and cleaned of control characters', async () => {
  const { cut } = await import('../src/format.js');
  assert.equal(cut('ab😀cd', 3), 'ab😀');
  assert.equal(cut('a\u0007b', 10), 'a b');
  assert.doesNotThrow(() => encodeURIComponent(cut('x'.repeat(23) + '😀😀', 24)));
});

test('transcripts: dedupes repeated assistant lines and keeps only label fields', async () => {
  const s = await loadSession(fixture);
  assert.equal(s.calls.length, 5, 'one call per message id');
  assert.equal(s.calls[0].usage.output_tokens, 150, 'final usage wins');
  assert.equal(s.title, 'Cart tax fix');
  assert.equal(s.results.length, 2);
  assert.equal(s.compactions.length, 1);
  assert.deepEqual(Object.keys(s.calls[1].toolUses[0].input), ['file_path']);
});

test('analyze: totals, cache-miss causes, eaters and compounding trim savings', async () => {
  const s = await loadSession(fixture);
  const trims = [{ ts: Date.parse('2026-11-01T10:00:30Z'), session: 'fx', agent: 'main', toolUseId: 'toolu_1', command: 'npm test', rawTokens: 2000, keptTokens: 200, rawFile: '' }];
  const a = analyze(s, trims);
  const expected = s.calls.reduce((sum, c) => sum + costOf(c.usage, c.model).total, 0);
  close(a.totals.cost, expected, 'total');
  assert.equal(a.totals.calls, 5);

  const causes = a.cache.misses.map((m) => m.cause);
  assert.deepEqual(causes, ['expired', 'compaction', 'model-switch']);
  close(a.cache.misses[0].lost, (23005 * 4.8) / 1e6, 'expired miss penalty');
  assert.equal(a.cache.misses[1].lost, 0, 'compaction is expected, not lost');

  assert.equal(a.eaters[0].tool, 'Bash');
  assert.equal(a.eaters[0].tokens, 2000);
  assert.equal(a.eaters[1].label, 'src/cart.js');

  // Saved tokens are written once by the next call, then read by each later call until compaction.
  assert.equal(a.trim.savedTokens, 1800);
  close(a.trim.savedUsd, (1800 * 5) / 1e6 + (1800 * 0.2) / 1e6, 'compounding savings');
  assert.ok(a.cache.savedUsd > 0, 'caching saved money');
});

test('tips and receipt render from measured numbers', async () => {
  const a = analyze(await loadSession(fixture), []);
  const t = tips(a);
  assert.match(t[0].text, /long break/);
  const r = renderReceipt(a, { color: false });
  assert.match(r, /TOTAL/);
  assert.match(r, /Cart tax fix/);
  assert.ok(r.split('\n').every((l) => [...l].length <= 46), 'fits 46 columns');
});

test('labels: relative paths, long absolute paths shortened', () => {
  assert.equal(labelFor('Read', { file_path: '/a/b/src/x.ts' }, '/a/b'), 'src/x.ts');
  assert.equal(labelFor('Read', { file_path: '/other/deep/path/to/file.ts' }, '/a/b'), '…/path/to/file.ts');
  assert.equal(labelFor('Bash', { command: 'npm test\necho hi' }, ''), 'npm test');
});
