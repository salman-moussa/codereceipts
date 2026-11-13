/** Shorten text by characters (not UTF-16 units) and drop control characters. */
export function cut(s, n) {
  const clean = String(s ?? '').replace(/\p{Cc}/gu, ' ');
  const chars = [...clean];
  return chars.length > n ? chars.slice(0, n).join('') : clean;
}

export function usd(n) {
  if (!Number.isFinite(n)) return '$0.00';
  const abs = Math.abs(n);
  const s = abs >= 1000 ? abs.toLocaleString('en-US', { maximumFractionDigits: 0 }) : abs < 0.01 && abs > 0 ? abs.toFixed(4) : abs.toFixed(2);
  return (n < 0 ? '-$' : '$') + s;
}

export function num(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(Math.round(n));
}

export function int(n) {
  return Math.round(n).toLocaleString('en-US');
}

export function dur(ms) {
  if (!ms || ms < 0) return '0m';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function pct(x) {
  return `${Math.round(x * 100)}%`;
}

export function date(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function shortModel(m) {
  return String(m).replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1').replace(/^(\w)/, (c) => c.toUpperCase());
}

export const CAUSE_TEXT = {
  expired: 'cache expired (long break)',
  'model-switch': 'switched model',
  'prefix-changed': 'prompt or tools changed',
  compaction: 'compaction (expected)',
};
