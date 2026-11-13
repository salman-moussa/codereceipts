// Shrinks noisy command output (test runs, installs, builds, logs) while
// keeping every line that looks like an error or warning. Pure function:
// the hook saves the untrimmed output to disk, so nothing is lost.

// A command line is split into its parts (&&, ||, ;, |) and each part is
// classified by how it starts, so "grep webpack src/" is a read, not a build.
const RUNNER = String.raw`(?:(?:npx|bunx|sudo|time|nice|python3?\s+-m|py\s+-m|uv\s+run|poetry\s+run|pnpm\s+dlx|pnpm\s+exec|yarn\s+dlx)\s+)?`;
const TOOLS = [
  String.raw`(?:npm|pnpm|yarn|bun)\s+(?:test|t|install|i|ci|add|exec|run\s+\S*(?:build|test|lint|e2e|check|dev)\S*)`,
  String.raw`jest|vitest|mocha|playwright|pytest|tox|tsc|eslint|ruff|mypy|flake8|pylint|phpunit|rspec|webpack|make|journalctl`,
  String.raw`next\s+build|vite\s+build|go\s+(?:test|build|vet|mod)|cargo\s+(?:test|build|check|clippy|install)`,
  String.raw`(?:\./)?(?:mvnw?|gradlew?)|dotnet\s+(?:build|test|restore|publish)|flutter\s+(?:test|build|analyze|pub)`,
  String.raw`pip3?\s+install|uv\s+(?:pip|sync|add)|poetry\s+(?:install|add)|docker(?:-compose)?\s+(?:build|compose|logs|pull)`,
  String.raw`kubectl\s+logs|git\s+log|composer\s+install|bundle\s+install`,
].join('|');
const NOISY = new RegExp(`^${RUNNER}(?:${TOOLS})\\b`);

// Parts whose output Claude asked to read in full: never trimmed.
const READ = /^(?:cat|head|tail|sed|awk|less|more|type|bat|jq|yq|grep|egrep|fgrep|rg|ag|find|fd|ls|dir|tree|wc|Get-Content|gc|Select-String)\b|^git\s+(?:diff|show|blame|grep)\b|^git\s+log\b.*\s(?:-p|--patch)\b/;

/** @param {string} command */
export function classify(command) {
  const parts = command
    .split(/&&|\|\||;|\||\n/)
    .map((p) => p.trim().replace(/^(?:\w+=\S*\s+)+/, ''))
    .filter(Boolean);
  return { read: parts.some((p) => READ.test(p)), noisy: parts.some((p) => NOISY.test(p)) };
}

const IMPORTANT =
  /error|fail|exception|traceback|panic|fatal|denied|refused|not found|cannot|can't|unable|undefined|warn|deprecat|✗|✘|✕|✖|×|●|ERR!|\bE\d{3,}\b|assert|expected|received|exit code|exited with|\bat\s+\S+\s*\(|^\s+at\s|^\s*File "/i;

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

export const MIN_CHARS = 3000;
const HUGE_CHARS = 60_000;
const MAX_LINES = 220;
const HEAD = 60;
const TAIL = 90;

/** Normalize a line to a shape so "similar" lines (same prefix, different numbers) group together. */
const shape = (/** @type {string} */ l) => l.trim().slice(0, 14).replace(/\d+/g, '#');

/**
 * @param {string} text
 * @param {string} command
 * @returns {{ text: string, rawChars: number, keptChars: number } | null} null when trimming is not worth it
 */
export function trim(text, command = '') {
  if (!text || text.length < MIN_CHARS) return null;
  const kind = classify(command);
  if (kind.read) return null;
  if (!kind.noisy && text.length < HUGE_CHARS) return null;

  // 1. Strip colors and keep only the final state of \r progress lines.
  let lines = text
    .replace(ANSI, '')
    .split('\n')
    // A trailing \r is a Windows line ending; an inner \r redraws a progress line.
    .map((l) => (l.replace(/\r+$/, '').split('\r').pop() || '').trimEnd());

  // 2. Collapse exact repeats.
  /** @type {string[]} */
  const dedup = [];
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    dedup.push(lines[i]);
    if (j - i > 2) dedup.push(`  … same line ${j - i - 1} more times`);
    else if (j - i === 2) dedup.push(lines[i]);
    i = j;
  }
  lines = dedup;

  // 3. Collapse runs of similar, unimportant lines (passing tests, download progress, compile steps).
  /** @type {string[]} */
  const runs = [];
  for (let i = 0; i < lines.length; ) {
    const s = shape(lines[i]);
    let j = i + 1;
    while (j < lines.length && lines[j].trim() && shape(lines[j]) === s && !IMPORTANT.test(lines[j])) j++;
    const n = j - i;
    if (n >= 6 && s && !IMPORTANT.test(lines[i])) {
      runs.push(lines[i], lines[i + 1], `  … ${n - 3} similar lines`, lines[j - 1]);
    } else runs.push(...lines.slice(i, j));
    i = j;
  }
  lines = runs;

  // 4. Still long: keep head, tail, and every important line with a little context.
  if (lines.length > MAX_LINES) {
    const keep = new Set();
    for (let i = 0; i < HEAD; i++) keep.add(i);
    for (let i = lines.length - TAIL; i < lines.length; i++) keep.add(i);
    lines.forEach((l, i) => {
      if (IMPORTANT.test(l)) for (let k = i - 2; k <= i + 3; k++) if (k >= 0 && k < lines.length) keep.add(k);
    });
    /** @type {string[]} */
    const out = [];
    let gap = 0;
    lines.forEach((l, i) => {
      if (keep.has(i)) {
        if (gap) out.push(`  … ${gap} lines omitted`);
        gap = 0;
        out.push(l);
      } else gap++;
    });
    lines = out;
  }

  const result = lines.join('\n');
  if (result.length > text.length * 0.8) return null;
  return { text: result, rawChars: text.length, keptChars: result.length };
}
