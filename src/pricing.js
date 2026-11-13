// List prices in USD per million tokens (Anthropic first-party API).
// Cache writes are 1.25x input (5-minute TTL) and 2x input (1-hour TTL).
// Cache reads differ by model, so each row carries its own `read` price.
// Source: Anthropic pricing as of 2026-11. Update this table when prices change.

/** @typedef {{ input: number, output: number, read: number, longContext?: { above: number, input: number, output: number } }} Price */

/** @type {Array<[string, Price]>} longest-prefix match, so keep specific ids before general ones */
const TABLE = [
  ['claude-fable-5-2', { input: 8, output: 40, read: 0.2 }],
  ['claude-mythos-5-2', { input: 8, output: 40, read: 0.2 }],
  ['claude-fable-5-1', { input: 10, output: 50, read: 0.25 }],
  ['claude-mythos-5-1', { input: 10, output: 50, read: 0.25 }],
  ['claude-fable-5', { input: 10, output: 50, read: 1 }],
  ['claude-mythos-5', { input: 10, output: 50, read: 1 }],
  ['claude-opus-5-5', { input: 4, output: 20, read: 0.2 }],
  ['claude-opus-5', { input: 5, output: 25, read: 0.5 }],
  ['claude-opus-4-8', { input: 5, output: 25, read: 0.5 }],
  ['claude-opus-4-7', { input: 5, output: 25, read: 0.5 }],
  ['claude-opus-4-6', { input: 5, output: 25, read: 0.5 }],
  ['claude-opus-4-5', { input: 5, output: 25, read: 0.5 }],
  ['claude-opus-4-1', { input: 15, output: 75, read: 1.5 }],
  ['claude-opus-4', { input: 15, output: 75, read: 1.5 }],
  ['claude-sonnet-5-5', { input: 2, output: 10, read: 0.1 }],
  ['claude-sonnet-5', { input: 2, output: 10, read: 0.2 }],
  ['claude-sonnet-4', { input: 3, output: 15, read: 0.3 }],
  // ponytail: Haiku 5.5 long-context tier assumes cache rates scale with the tier's input price.
  ['claude-haiku-5-5', { input: 0.1, output: 0.5, read: 0.01, longContext: { above: 100_000, input: 0.5, output: 2.5 } }],
  ['claude-haiku-4-5', { input: 1, output: 5, read: 0.1 }],
  ['claude-3-5-haiku', { input: 0.8, output: 4, read: 0.08 }],
];

/** @param {string | undefined} model */
export function priceFor(model) {
  if (!model) return null;
  const id = model.replace(/^(anthropic\.|us\.anthropic\.|eu\.anthropic\.)/, '').replace(/\[1m\]$/, '');
  for (const [prefix, price] of TABLE) if (id.startsWith(prefix)) return price;
  return null;
}

/**
 * @typedef {object} Usage
 * @property {number} [input_tokens]
 * @property {number} [output_tokens]
 * @property {number} [cache_read_input_tokens]
 * @property {number} [cache_creation_input_tokens]
 * @property {{ ephemeral_5m_input_tokens?: number, ephemeral_1h_input_tokens?: number }} [cache_creation]
 * @property {string} [speed]
 */

/**
 * Split one API call's cost into its four meters.
 * @param {Usage} u
 * @param {string} model
 */
export function costOf(u, model) {
  const p = priceFor(model);
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m = Math.max(0, write - write1h);
  if (!p) return { known: false, input: 0, output: 0, read: 0, write: 0, total: 0, noCache: 0 };

  const prompt = input + read + write;
  const tier = p.longContext && prompt > p.longContext.above ? p.longContext : null;
  const inPrice = tier ? tier.input : p.input;
  const outPrice = tier ? tier.output : p.output;
  const readPrice = tier ? p.read * (tier.input / p.input) : p.read;
  const fast = u.speed === 'fast' ? 2 : 1;
  const M = 1e6;

  const c = {
    known: true,
    input: (input * inPrice * fast) / M,
    output: (output * outPrice * fast) / M,
    read: (read * readPrice * fast) / M,
    write: ((write5m * 1.25 + write1h * 2) * inPrice * fast) / M,
    total: 0,
    // What the same call would cost with no prompt caching at all.
    noCache: ((prompt * inPrice + output * outPrice) * fast) / M,
  };
  c.total = c.input + c.output + c.read + c.write;
  return c;
}

/** Price of re-caching `tokens` instead of reading them: what one cache miss costs. */
export function missPenalty(tokens, model, ttl = '5m') {
  const p = priceFor(model);
  if (!p) return 0;
  const writeMult = ttl === '1h' ? 2 : 1.25;
  return (tokens * (p.input * writeMult - p.read)) / 1e6;
}

/** Cost of carrying `tokens` through one later call as a cache read. */
export function readCost(tokens, model) {
  const p = priceFor(model);
  return p ? (tokens * p.read) / 1e6 : 0;
}

/** Cost of writing `tokens` into the cache once. */
export function writeCost(tokens, model, ttl = '5m') {
  const p = priceFor(model);
  return p ? (tokens * p.input * (ttl === '1h' ? 2 : 1.25)) / 1e6 : 0;
}

export const KNOWN_MODELS = TABLE.map(([id]) => id);
