import { MONTHS, addDays, esc, fmtNum, fmtRange } from './model.js';
import { CARD, CURRENT, INK, INK3, PREVIOUS, RULE, RULE_STRONG } from './theme.js';

/** One cumulative-commits line per period, aligned by day of period. Current first. */
export function compareSeries(model, metric = 'commits') {
  const line = (stats, i) => ({
    label: i < 0 ? 'This period' : i === 0 ? 'Previous period' : `${i + 1} periods back`,
    range: fmtRange(stats.period.from, stats.period.to),
    color: i < 0 ? CURRENT : PREVIOUS[i],
    dash: i < 0 ? [] : [4, 3],
    width: i < 0 ? 2 : 1.5,
    values: stats.series[metric].cumulative,
    stats,
  });
  return [line(model.current, -1), ...model.previous.map((p, i) => line(p, i))];
}

function niceMax(v) {
  const pow = 10 ** Math.floor(Math.log10(Math.max(1, v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}

export const fmtCompact = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : fmtNum(v));

export function layoutCompare(series, o = {}) {
  const { W = 1120, H = 280, padL = 48, padR = 170, padT = 14, padB = 30 } = o;
  const n = Math.max(1, ...series.map((s) => s.values.length));
  const max = niceMax(Math.max(1, ...series.map((s) => s.values[s.values.length - 1] || 0)));
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const x = (i) => padL + (n === 1 ? 0 : (i / (n - 1)) * plotW);
  const y = (v) => padT + (1 - v / max) * plotH;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ v: max * f, y: y(max * f) }));

  // Month ticks come from the current period; earlier periods share its day axis.
  const from = series[0].stats.period.from;
  const every = n > 420 ? 3 : n > 240 ? 2 : 1;
  const xTicks = [];
  for (let i = 0, seen = 0; i < n; i++) {
    const day = addDays(from, i);
    if (day.slice(8) !== '01' || seen++ % every) continue;
    const mon = Number(day.slice(5, 7)) - 1;
    xTicks.push({ x: x(i), label: mon === 0 ? `Jan ${day.slice(0, 4)}` : MONTHS[mon] });
  }

  const step = Math.max(1, Math.floor(n / 360));
  const paths = series.map((s) => {
    const points = [];
    for (let i = 0; i < s.values.length; i += step) points.push([x(i), y(s.values[i])]);
    const last = s.values.length - 1;
    if (last % step) points.push([x(last), y(s.values[last])]);
    return { ...s, points, d: points.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('') };
  });

  // Direct labels at the line ends, nudged apart so two close finishes don't collide.
  const ends = paths
    .map((p) => {
      const [dotX, dotY] = p.points[p.points.length - 1];
      return { label: p.label, value: p.values[p.values.length - 1] || 0, color: p.color, dash: p.dash, dotX, dotY, y: dotY };
    })
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 32);
  const overflow = ends.length ? ends[ends.length - 1].y - (H - padB) : 0;
  if (overflow > 0) ends.forEach((e) => { e.y -= overflow; });

  return { W, H, padL, padR, padT, padB, n, max, x, y, yTicks, xTicks, paths, ends };
}

export function compareSVG(L) {
  const r = (v) => v.toFixed(1);
  const grid = L.yTicks.map((t) => `
    <line x1="${L.padL}" x2="${L.W - L.padR}" y1="${r(t.y)}" y2="${r(t.y)}" stroke="${t.v === 0 ? RULE_STRONG : RULE}"/>
    <text class="c-axis" x="${L.padL - 8}" y="${r(t.y + 4)}" text-anchor="end">${fmtCompact(t.v)}</text>`).join('');
  const xTicks = L.xTicks.map((t) => `<text class="c-axis" x="${r(t.x)}" y="${L.H - 8}" text-anchor="middle">${t.label}</text>`).join('');
  const lines = [...L.paths].reverse().map((p) =>
    `<path d="${p.d}" fill="none" stroke="${p.color}" stroke-width="${p.width}" stroke-linejoin="round" stroke-linecap="round"${p.dash.length ? ` stroke-dasharray="${p.dash.join(' ')}"` : ''}/>`).join('');
  const lx = L.W - L.padR + 14;
  const ends = L.ends.map((e) => `
    <circle cx="${r(e.dotX)}" cy="${r(e.dotY)}" r="3.5" fill="${e.dash.length ? e.color : INK}" stroke="${CARD}" stroke-width="1.5"/>
    <line x1="${lx}" x2="${lx + 14}" y1="${r(e.y - 5)}" y2="${r(e.y - 5)}" stroke="${e.color}" stroke-width="2.5"${e.dash.length ? ' stroke-dasharray="4 3"' : ''}/>
    <text class="c-end-label" x="${lx + 20}" y="${r(e.y - 1)}">${esc(e.label)}</text>
    <text class="c-end-value" x="${lx + 20}" y="${r(e.y + 15)}">${fmtNum(e.value)}</text>`).join('');
  const cross = `<g class="c-cross" style="display:none">
    <line class="c-x" y1="${L.padT}" y2="${L.H - L.padB}" stroke="${INK3}" stroke-width="1"/>
    ${L.paths.map((p, i) => `<circle class="c-dot" data-i="${i}" r="4" fill="${p.color}" stroke="${CARD}" stroke-width="2"/>`).join('')}
  </g>`;
  return `<svg class="compare" viewBox="0 0 ${L.W} ${L.H}" role="img" aria-label="Cumulative commits by period">${grid}${xTicks}${lines}${ends}${cross}<rect class="c-hit" x="${L.padL}" y="${L.padT}" width="${L.W - L.padL - L.padR}" height="${L.H - L.padT - L.padB}" fill="transparent"/></svg>`;
}

