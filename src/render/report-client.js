// Runs inside the generated report page. No dependencies.
(function () {
  const D = JSON.parse(document.getElementById('data').textContent);
  const NS = 'http://www.w3.org/2000/svg';
  const $ = (s) => document.querySelector(s);

  const usd = (n) => {
    const a = Math.abs(n || 0);
    const s = a >= 1000 ? a.toLocaleString('en-US', { maximumFractionDigits: 0 }) : a > 0 && a < 0.01 ? a.toFixed(4) : a.toFixed(2);
    return (n < 0 ? '-$' : '$') + s;
  };
  const num = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n || 0))).replace('.0', '');
  const when = (ts) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const model = (m) => String(m).replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1').replace(/^\w/, (c) => c.toUpperCase());
  const el = (tag, attrs = {}, text) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };
  const svgEl = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const CAUSE = { expired: 'Cache expired (long break)', 'model-switch': 'Switched model', 'prefix-changed': 'Prompt or tools changed', compaction: 'Compaction (expected)' };

  // Points: [index, ts, read, write, input, cost, cum, modelIndex, missIndex]
  const P = D.points;
  const models = D.models;

  // ---------- header and tiles ----------
  $('#title').textContent = D.title;
  const meta = $('#meta');
  const metaItems = [D.project && `Folder ${D.project}`, `Started ${when(D.start)}`, `Duration ${D.duration}`, `${num(D.totals.calls)} API calls`, D.byModel.map((m) => model(m.model)).join(', ')].filter(Boolean);
  for (const m of metaItems) meta.appendChild(el('span', {}, m));

  const misses = D.misses;
  const expired = misses.filter((m) => m.cause === 'expired').length;
  const tiles = [
    { label: 'Total spent', value: usd(D.totals.cost), note: `${usd(D.mainCost)} main · ${usd(D.totals.cost - D.mainCost)} in ${D.agents.length} subagents` },
    { label: 'Caching saved you', value: usd(Math.max(0, D.cache.savedUsd)), note: `${Math.round(D.cache.hitRate * 100)}% of input read from cache`, cls: 'good' },
    { label: 'Lost to cache misses', value: usd(D.cache.lostUsd), note: misses.length ? `${misses.length} misses${expired ? `, ${expired} from long breaks` : ''}` : 'No misses', cls: D.cache.lostUsd >= 0.01 ? 'bad' : '' },
    { label: 'Peak context', value: `${num(D.peakContext)} tok`, note: D.compactions ? `${D.compactions} compaction${D.compactions > 1 ? 's' : ''}` : 'No compactions' },
  ];
  if (D.trim.events) tiles[3] = { label: 'Trimmed by Receipts', value: usd(D.trim.savedUsd), note: `${num(D.trim.savedTokens)} tokens kept out of context`, cls: 'good' };
  const tileBox = $('#tiles');
  for (const t of tiles) {
    const d = el('div', { class: `tile ${t.cls || ''}` });
    d.append(el('div', { class: 'label' }, t.label), el('div', { class: 'value' }, t.value), el('div', { class: 'note' }, t.note));
    tileBox.appendChild(d);
  }

  // ---------- shared hover across the two time charts ----------
  const hoverers = [];
  const setHover = (i) => hoverers.forEach((h) => h(i));

  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  function tipHtml(i) {
    const p = P[i];
    const ctx = p[2] + p[3] + p[4];
    const tip = document.createElement('div');
    const head = el('div', {}, '');
    head.append(el('b', {}, `Call ${(p[0] + 1).toLocaleString()}`), document.createTextNode(` · ${when(p[1])}`));
    tip.append(head, el('div', { style: 'color:var(--text-3);margin-bottom:6px' }, model(models[p[7]])));
    const row = (label, value, color) => {
      const r = el('div', { class: 'row' });
      const l = el('span');
      if (color) l.append(el('i', { class: 'sw', style: `background:${color}` }));
      l.append(document.createTextNode(label));
      r.append(l, el('span', {}, value));
      return r;
    };
    tip.append(
      row('Context', `${num(ctx)} tok`),
      row('Read from cache', num(p[2]), 'var(--s1)'),
      row('Written to cache', num(p[3]), 'var(--s2)'),
      row('Fresh input', num(p[4]), 'var(--s3)'),
      row('This call', usd(p[5])),
      row('Running total', usd(p[6])),
    );
    if (p[8] >= 0) {
      const m = misses[p[8]];
      tip.append(el('div', { class: 'miss' }, `▼ Cache miss: ${CAUSE[m.cause] || m.cause}${m.lost >= 0.01 ? ` (+${usd(m.lost)})` : ''}`));
    }
    return tip;
  }

  function timeChart(box, opts) {
    const tip = el('div', { class: 'tip', role: 'status' });
    box.appendChild(tip);
    let svg;
    let xOf;
    let pad;
    let w;
    let h;
    let cross;
    let dot;

    function draw() {
      if (svg) svg.remove();
      w = Math.max(300, box.clientWidth);
      h = opts.height;
      pad = { l: 52, r: 12, t: 14, b: 26 };
      const iw = w - pad.l - pad.r;
      const ih = h - pad.t - pad.b;
      const n = P.length;
      const yMax = niceMax(Math.max(...P.map(opts.top), 0));
      xOf = (i) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
      const yOf = (v) => pad.t + ih - (v / yMax) * ih;
      svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, height: h, role: 'img', 'aria-label': opts.label });

      for (let k = 0; k <= 4; k++) {
        const v = (yMax * k) / 4;
        const y = yOf(v);
        svg.appendChild(svgEl('line', { x1: pad.l, x2: w - pad.r, y1: y, y2: y, stroke: 'var(--grid)', 'stroke-width': 1 }));
        const t = svgEl('text', { x: pad.l - 8, y: y + 4, 'text-anchor': 'end' });
        t.textContent = opts.yFmt(v);
        svg.appendChild(t);
      }
      const ticks = Math.min(w < 520 ? 4 : 6, n);
      for (let k = 0; k < ticks; k++) {
        const i = Math.round((k / Math.max(1, ticks - 1)) * (n - 1));
        const t = svgEl('text', { x: xOf(i), y: h - 6, 'text-anchor': k === 0 ? 'start' : k === ticks - 1 ? 'end' : 'middle' });
        t.textContent = `#${(P[i][0] + 1).toLocaleString()}`;
        svg.appendChild(t);
      }

      for (const c of D.compactionIdx) {
        const x = xOf(c);
        svg.appendChild(svgEl('line', { x1: x, x2: x, y1: pad.t, y2: pad.t + ih, stroke: 'var(--text-3)', 'stroke-dasharray': '3 3', 'stroke-width': 1 }));
      }

      opts.paint(svg, { xOf, yOf, ih, pad });

      cross = svgEl('line', { y1: pad.t, y2: pad.t + ih, stroke: 'var(--text-3)', 'stroke-width': 1, opacity: 0 });
      dot = svgEl('circle', { r: 4, fill: 'var(--text)', stroke: 'var(--surface)', 'stroke-width': 2, opacity: 0 });
      svg.append(cross, dot);
      const hit = svgEl('rect', { x: pad.l, y: 0, width: iw, height: h, fill: 'transparent' });
      const pick = (evt) => {
        const r = svg.getBoundingClientRect();
        const x = ((evt.clientX - r.left) / r.width) * w;
        const i = Math.max(0, Math.min(n - 1, Math.round(((x - pad.l) / iw) * (n - 1))));
        setHover(i);
      };
      hit.addEventListener('pointermove', pick);
      hit.addEventListener('pointerdown', pick);
      hit.addEventListener('pointerleave', () => setHover(-1));
      svg.appendChild(hit);
      box.insertBefore(svg, tip);
      opts.yOf = yOf;
    }

    hoverers.push((i) => {
      if (i < 0 || !svg) {
        tip.classList.remove('on');
        cross.setAttribute('opacity', 0);
        dot.setAttribute('opacity', 0);
        return;
      }
      const x = xOf(i);
      cross.setAttribute('x1', x);
      cross.setAttribute('x2', x);
      cross.setAttribute('opacity', 1);
      dot.setAttribute('cx', x);
      dot.setAttribute('cy', opts.yOf(opts.top(P[i])));
      dot.setAttribute('opacity', 1);
      if (opts.showTip) {
        tip.replaceChildren(tipHtml(i));
        tip.classList.add('on');
        const scale = box.clientWidth / w;
        const left = x * scale;
        const tw = tip.offsetWidth;
        tip.style.left = `${left + 14 + tw > box.clientWidth ? Math.max(0, left - tw - 14) : left + 14}px`;
        tip.style.top = '8px';
      }
    });
    draw();
    return draw;
  }

  const redraws = [];
  if (P.length) {
    const ctxTop = (p) => p[2] + p[3] + p[4];
    redraws.push(
      timeChart($('#ctxChart'), {
        height: 300,
        label: 'Context size per API call',
        top: ctxTop,
        yFmt: num,
        showTip: true,
        paint(svg, { xOf, yOf }) {
          const layers = [
            { f: (p) => p[2], color: 'var(--s1)' },
            { f: (p) => p[2] + p[3], color: 'var(--s2)' },
            { f: (p) => p[2] + p[3] + p[4], color: 'var(--s3)' },
          ];
          let prev = P.map(() => 0);
          for (const layer of layers) {
            const top = P.map(layer.f);
            let d = `M ${xOf(0)} ${yOf(top[0])}`;
            for (let i = 1; i < P.length; i++) d += ` L ${xOf(i)} ${yOf(top[i])}`;
            for (let i = P.length - 1; i >= 0; i--) d += ` L ${xOf(i)} ${yOf(prev[i])}`;
            svg.appendChild(svgEl('path', { d: d + ' Z', fill: layer.color }));
            prev = top;
          }
          for (const p of P) {
            if (p[8] < 0) continue;
            const m = misses[p[8]];
            const x = xOf(P.indexOf(p));
            const y = yOf(ctxTop(p)) - 4;
            const color = m.cause === 'compaction' ? 'var(--text-3)' : 'var(--critical)';
            svg.appendChild(svgEl('path', { d: `M ${x - 5} ${y - 8} L ${x + 5} ${y - 8} L ${x} ${y} Z`, fill: color, stroke: 'var(--surface)', 'stroke-width': 1.5 }));
          }
        },
      }),
    );
    redraws.push(
      timeChart($('#costChart'), {
        height: 200,
        label: 'Running cost',
        top: (p) => p[6],
        yFmt: (v) => usd(v).replace('.00', ''),
        showTip: false,
        paint(svg, { xOf, yOf }) {
          let d = `M ${xOf(0)} ${yOf(P[0][6])}`;
          for (let i = 1; i < P.length; i++) d += ` L ${xOf(i)} ${yOf(P[i][6])}`;
          svg.appendChild(svgEl('path', { d, fill: 'none', stroke: 'var(--s1)', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
        },
      }),
    );
  } else {
    $('#ctxChart').append(el('p', { class: 'empty' }, 'No API calls in this session yet.'));
  }

  let t;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => redraws.forEach((r) => r()), 120);
  });

  // ---------- table view for the timeline ----------
  const tbody = $('#ctxTable tbody');
  const stepRows = Math.max(1, Math.ceil(P.length / 40));
  for (let i = 0; i < P.length; i += stepRows) {
    const p = P[i];
    const tr = el('tr');
    tr.append(el('td', {}, `#${p[0] + 1}`), el('td', {}, when(p[1])), el('td', {}, model(models[p[7]])), el('td', { class: 'num' }, num(p[2] + p[3] + p[4])), el('td', { class: 'num' }, num(p[2])), el('td', { class: 'num' }, num(p[3])), el('td', { class: 'num' }, usd(p[6])));
    tbody.appendChild(tr);
  }

  // ---------- bar lists ----------
  function bars(box, rows, fmt) {
    if (!rows.length) return box.append(el('p', { class: 'empty' }, 'Nothing here.'));
    const max = Math.max(...rows.map((r) => r.value), 1e-9);
    for (const r of rows) {
      const b = el('div', { class: 'bar' });
      const top = el('div', { class: 'top' });
      const name = el('span', { class: 'name', title: r.name }, r.name);
      if (r.note) name.append(el('small', {}, r.note));
      top.append(name, el('span', { class: 'val' }, fmt(r.value)));
      const track = el('div', { class: 'track' });
      track.append(el('div', { class: 'fill', style: `width:${Math.max(0.5, (r.value / max) * 100)}%` }));
      b.append(top, track);
      box.appendChild(b);
    }
  }
  const m = D.totals.costByMeter;
  bars($('#meters'), [
    { name: 'Output', note: `${num(D.totals.output)} tok`, value: m.output },
    { name: 'Cache writes', note: `${num(D.totals.write)} tok`, value: m.write },
    { name: 'Cache reads', note: `${num(D.totals.read)} tok`, value: m.read },
    { name: 'Fresh input', note: `${num(D.totals.input)} tok`, value: m.input },
  ].sort((a, b) => b.value - a.value), usd);
  bars($('#models'), D.byModel.map((x) => ({ name: model(x.model), note: `${num(x.calls)} calls`, value: x.cost })), usd);
  if (D.agents.length) {
    bars($('#agents'), D.agents.slice(0, 10).map((g) => ({ name: g.description || g.type, note: `${g.type} · ${model(g.model)}`, value: g.cost })), usd);
  } else $('#agentsCard').remove();
  bars($('#eaters'), D.eaters.map((e) => ({ name: e.tool.startsWith('mcp__') ? e.tool.split('__').slice(1).join(' › ') : e.label === e.tool ? e.tool : `${e.tool} ${e.label}`, note: e.count > 1 ? `${e.count}x` : '', value: e.tokens })), (v) => `${num(v)} tok`);

  // ---------- misses table ----------
  const mt = $('#missTable tbody');
  const sorted = [...misses].sort((a, b) => b.lost - a.lost).slice(0, 15);
  if (!sorted.length) $('#missTable').replaceWith(el('p', { class: 'empty' }, 'No cache misses. Nice.'));
  for (const x of sorted) {
    const tr = el('tr');
    const c = el('td');
    c.append(el('span', { class: `cause ${x.cause === 'compaction' ? 'expected' : ''}` }, CAUSE[x.cause] || x.cause));
    const gap = x.gapMs > 3600000 ? `${Math.round(x.gapMs / 3600000)}h idle` : x.gapMs > 60000 ? `${Math.round(x.gapMs / 60000)}m idle` : '';
    tr.append(el('td', {}, when(x.ts)), c, el('td', {}, gap), el('td', { class: 'num' }, num(x.tokens)), el('td', { class: 'num' }, usd(x.lost)));
    mt.appendChild(tr);
  }

  // ---------- tips ----------
  const tl = $('#tips');
  if (!D.tips.length) tl.replaceWith(el('p', { class: 'empty' }, 'Nothing to fix here. This session was already lean.'));
  for (const tip of D.tips) tl.appendChild(el('li', {}, tip));

  // ---------- share card ----------
  $('#preview').innerHTML = D.card; // generated by Receipts itself, all text escaped
  const name = `receipt-${D.id.slice(0, 8)}`;
  const download = (blob, file) => {
    const a = el('a', { href: URL.createObjectURL(blob), download: file });
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  $('#dlSvg').addEventListener('click', () => download(new Blob([D.card], { type: 'image/svg+xml' }), `${name}.svg`));
  $('#dlPng').addEventListener('click', () => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      c.toBlob((b) => b && download(b, `${name}.png`), 'image/png');
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(D.card);
  });
})();
