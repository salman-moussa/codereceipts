import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { home } from './ledger.js';
import { cut } from './format.js';

const CACHE_VERSION = 2;

export function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function projectsDir() {
  return path.join(claudeDir(), 'projects');
}

/**
 * Every main session transcript, newest first.
 * @returns {{ id: string, file: string, mtime: number, size: number }[]}
 */
export function listSessions(dir = projectsDir()) {
  /** @type {{ id: string, file: string, mtime: number, size: number }[]} */
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const proj of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const pdir = path.join(dir, proj.name);
    for (const f of fs.readdirSync(pdir)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(pdir, f);
      const st = fs.statSync(file);
      out.push({ id: f.slice(0, -6), file, mtime: st.mtimeMs, size: st.size });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** @param {string} idOrPath */
export function findSession(idOrPath) {
  if (idOrPath.endsWith('.jsonl') && fs.existsSync(idOrPath)) return path.resolve(idOrPath);
  const hit = listSessions().find((s) => s.id === idOrPath || s.id.startsWith(idOrPath));
  return hit ? hit.file : null;
}

/**
 * @typedef {object} Call
 * @property {string} id
 * @property {number} ts
 * @property {string} model
 * @property {import('./pricing.js').Usage} usage
 * @property {string} agent  'main' or the subagent id
 * @property {{ id: string, name: string, input: any }[]} toolUses
 *
 * @typedef {object} ToolResult
 * @property {string} toolUseId
 * @property {number} ts
 * @property {number} chars
 * @property {boolean} image
 * @property {string} agent
 *
 * @typedef {object} Session
 * @property {string} id
 * @property {string} file
 * @property {string} title
 * @property {string} cwd
 * @property {Call[]} calls
 * @property {ToolResult[]} results
 * @property {{ ts: number, preTokens: number, postTokens: number, trigger: string, agent: string }[]} compactions
 * @property {{ id: string, type: string, description: string }[]} agents
 */

const WANTED = ['"type":"assistant"', '"type":"user"', 'compact_boundary', '"type":"custom-title"'];
const KEEP_INPUT = ['file_path', 'notebook_path', 'command', 'pattern', 'url', 'query', 'description', 'subagent_type'];

/** Keep only the tool-input fields used for labels, so cached sessions stay small. */
function slim(/** @type {any} */ input) {
  if (!input || typeof input !== 'object') return input;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of KEEP_INPUT) if (typeof input[k] === 'string') out[k] = input[k].slice(0, 200);
  return out;
}

/**
 * Parse one transcript file into calls, tool results and compactions.
 * Claude Code writes one line per content block, so assistant lines repeat
 * the same message id and usage: we keep one call per message id.
 * @param {string} file
 * @param {string} agent
 * @param {Session} into
 */
async function parseFile(file, agent, into) {
  /** @type {Map<string, Call>} */
  const byId = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!WANTED.some((w) => line.includes(w))) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // a line still being written
    }
    const ts = e.timestamp ? Date.parse(e.timestamp) : 0;
    const who = e.isSidechain && agent === 'main' ? 'sidechain' : agent;

    if (e.type === 'custom-title' && e.customTitle && agent === 'main') into.title = e.customTitle;
    if (!into.cwd && e.cwd && agent === 'main') into.cwd = e.cwd;

    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      const m = e.compactMetadata || {};
      into.compactions.push({ ts, preTokens: m.preTokens || 0, postTokens: m.postTokens || 0, trigger: m.trigger || 'auto', agent: who });
    }

    if (e.type === 'assistant' && e.message?.usage && e.message.model && e.message.model !== '<synthetic>') {
      const id = e.message.id || e.uuid;
      let call = byId.get(id);
      if (!call) {
        call = { id, ts, model: e.message.model, usage: e.message.usage, agent: who, toolUses: [] };
        byId.set(id, call);
        into.calls.push(call);
      } else {
        call.usage = e.message.usage; // later blocks carry the final output count
      }
      for (const c of e.message.content || []) {
        if (c.type === 'tool_use') call.toolUses.push({ id: c.id, name: c.name, input: slim(c.input) });
      }
    }

    if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c.type !== 'tool_result') continue;
        const { chars, image } = measure(c.content);
        into.results.push({ toolUseId: c.tool_use_id, ts, chars, image, agent: who });
      }
      if (!into.title && agent === 'main' && !e.isMeta) {
        const text = e.message.content.find((/** @type {any} */ c) => c.type === 'text')?.text;
        if (text && !text.startsWith('<')) into.title = text;
      }
    }
    if (e.type === 'user' && typeof e.message?.content === 'string' && !into.title && agent === 'main' && !e.isMeta) {
      if (!e.message.content.startsWith('<')) into.title = e.message.content;
    }
  }
}

/** @param {any} content */
function measure(content) {
  if (typeof content === 'string') return { chars: content.length, image: false };
  if (!Array.isArray(content)) return { chars: 0, image: false };
  let chars = 0;
  let image = false;
  for (const b of content) {
    if (b.type === 'text') chars += (b.text || '').length;
    else if (b.type === 'image') {
      image = true;
      chars += 6000; // ponytail: images billed by pixels, ~1.5k tokens is typical
    }
  }
  return { chars, image };
}

/**
 * Load a session with all of its subagent transcripts.
 * @param {string} file
 * @returns {Promise<Session>}
 */
export async function loadSession(file) {
  const id = path.basename(file, '.jsonl');
  const subDir = path.join(path.dirname(file), id, 'subagents');
  // Parsed sessions are cached by file size and modification time: big
  // transcripts take seconds to parse, a cached one loads in milliseconds.
  const stamp = [file, subDir].map((f) => {
    try {
      const st = fs.statSync(f);
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return '-';
    }
  }).join('|');
  const cacheFile = path.join(home(), 'cache', `${id}.json`);
  try {
    const hit = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (hit.v === CACHE_VERSION && hit.stamp === stamp) return hit.session;
  } catch {
    /* no cache yet */
  }
  /** @type {Session} */
  const s = { id, file, title: '', cwd: '', calls: [], results: [], compactions: [], agents: [] };
  await parseFile(file, 'main', s);

  if (fs.existsSync(subDir)) {
    for (const f of fs.readdirSync(subDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const agentId = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
      let meta = {};
      try {
        meta = JSON.parse(fs.readFileSync(path.join(subDir, f.replace(/\.jsonl$/, '.meta.json')), 'utf8'));
      } catch {
        /* meta is optional */
      }
      s.agents.push({ id: agentId, type: /** @type {any} */ (meta).agentType || 'agent', description: /** @type {any} */ (meta).description || '' });
      await parseFile(path.join(subDir, f), agentId, s);
    }
  }
  s.calls.sort((a, b) => a.ts - b.ts);
  s.results.sort((a, b) => a.ts - b.ts);
  s.title = cut(s.title || path.basename(s.cwd || '') || id.slice(0, 8), 80).trim();
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ v: CACHE_VERSION, stamp, session: s }));
  } catch {
    /* caching is optional */
  }
  return s;
}
