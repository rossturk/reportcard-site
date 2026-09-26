import { RAMP, thresholds, levelOf } from './heatmap.js';
import { DAY_MS, MONTHS, daysOf, parseKey, fmtDay, fmtNum, esc, metricOf, totalOf } from './model.js';
import { CARD, INK, RULE, TOMATO } from './theme.js';
import { statusDot } from './svg.js';

/**
 * What the two glyphs on a bar mean. It used to sit at the top right of the card, where
 * a reader took it for navigation — that corner is where an app puts its controls. It
 * belongs with the other key, under the chart, so both are read in the same glance.
 */
export const GANTT_KEY = '◯ new project · ◆ release';

/** A new project's bar begins the day it was created, so idle time before the first commit shows. */
export function spanStart(u) {
  if (u.isNew && u.createdDay && u.firstDay && u.createdDay < u.firstDay) return u.createdDay;
  return u.firstDay;
}

/**
 * The timeline's rows: chronological by when each project began, with `limit` keeping
 * the biggest by the measure in play before they are re-sorted by time.
 *
 * A project with no commits in the period has no first day to place it by — a release
 * with no work behind it, or a repository only created — and is left out. It has no
 * bar to draw.
 */
export function ganttRows(units, limit = Infinity, metric = 'commits') {
  return units
    .filter((u) => u.firstDay)
    .sort((a, b) => totalOf(b, metric) - totalOf(a, metric))
    .slice(0, Number.isFinite(limit) ? limit : undefined)
    .sort((a, b) => spanStart(a).localeCompare(spanStart(b)) || totalOf(b, metric) - totalOf(a, metric));
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function layoutGantt(period, rows, o = {}) {
  const { W = 1120, labelW = 170, resultW = 150, countW = 72, rowH = 24, barH = 12, headH = 22, metric = 'commits' } = o;
  const t0 = parseKey(period.from).getTime();
  const t1 = parseKey(period.to).getTime() + DAY_MS;
  const trackX = labelW;
  const trackEnd = W - resultW - countW;
  const x = (t) => trackX + ((t - t0) / (t1 - t0)) * (trackEnd - trackX);
  const clamp = (v) => Math.max(trackX, Math.min(trackEnd, v));

  const weekly = rows.map((u) => {
    const weeks = new Map();
    for (const [day, count] of Object.entries(daysOf(u, metric))) {
      const d = parseKey(day);
      d.setUTCDate(d.getUTCDate() - d.getUTCDay());
      weeks.set(d.getTime(), (weeks.get(d.getTime()) || 0) + count);
    }
    return weeks;
  });
  // Calibrate shade on weekly totals, the unit the blocks actually render.
  const cuts = thresholds(weekly.flatMap((w) => [...w.values()]));

  const spanDays = (t1 - t0) / DAY_MS;
  const every = spanDays > 420 ? 3 : spanDays > 240 ? 2 : 1;
  const months = [];
  const m = parseKey(period.from);
  m.setUTCDate(1);
  m.setUTCMonth(m.getUTCMonth() + 1);
  for (let i = 0; m.getTime() < t1; i++) {
    const mon = m.getUTCMonth();
    const label = i % every === 0 ? (mon === 0 ? `Jan ${m.getUTCFullYear()}` : MONTHS[mon]) : '';
    months.push({ x: x(m.getTime()), label });
    m.setUTCMonth(mon + 1);
  }

  const laid = rows.map((u, r) => {
    const y = headH + r * rowH;
    const cy = y + (rowH - barH) / 2;
    const sx = clamp(x(parseKey(spanStart(u)).getTime()));
    const ex = Math.max(sx + 3, clamp(x(parseKey(u.lastDay).getTime() + DAY_MS)));
    const blocks = [...weekly[r]].map(([ws, count]) => {
      const bx = clamp(x(ws));
      return { x: bx, w: Math.max(2, clamp(x(ws + 7 * DAY_MS)) - bx - 0.75), level: Math.max(1, levelOf(count, cuts)) };
    });
    const releases = u.releases.map((rel) => clamp(x(parseKey(rel.publishedAt).getTime() + DAY_MS / 2)));
    return { u, y, cy, sx, ex, born: u.isNew, blocks, releases };
  });

  return { W, H: headH + rows.length * rowH + 6, rowH, barH, headH, trackX, trackEnd, resultX: trackEnd + 16, months, rows: laid, metric, cuts };
}

/**
 * The same chart, laid out for a screen that has no width to spare.
 *
 * A phone cannot hold a name column, a year of weeks and two columns of numbers side by
 * side — at 390px the desktop chart is 2.7 times the width of the window, and panning it
 * leaves the names behind. So the name moves above its own bar and the year takes the
 * full width of the card. Every bar is still drawn against one shared scale, which is
 * the whole point of the chart: the reader can still see that one project ran while
 * another was idle.
 *
 * What it gives up is density. A row costs a name's height as well as a bar's, and the
 * outcome and the count are dropped — they are in the timeline's tooltip and in the
 * sankey, and repeating them here would cost another column this layout does not have.
 */
export function layoutGanttPortrait(period, rows, o = {}) {
  const { W = 320, rowH = 34, barH = 11, labelH = 15, headH = 18, metric = 'commits' } = o;
  const t0 = parseKey(period.from).getTime();
  const t1 = parseKey(period.to).getTime() + DAY_MS;
  const x = (t) => ((t - t0) / (t1 - t0)) * W;
  const clamp = (v) => Math.max(0, Math.min(W, v));

  const weekly = rows.map((u) => {
    const weeks = new Map();
    for (const [day, count] of Object.entries(daysOf(u, metric))) {
      const d = parseKey(day);
      d.setUTCDate(d.getUTCDate() - d.getUTCDay());
      weeks.set(d.getTime(), (weeks.get(d.getTime()) || 0) + count);
    }
    return weeks;
  });
  const cuts = thresholds(weekly.flatMap((w) => [...w.values()]));

  // A label needs about 26px; past that they collide, so some months go unnamed and
  // keep only their rule.
  const monthCount = Math.max(1, Math.round((t1 - t0) / (30.4 * DAY_MS)));
  const every = Math.max(1, Math.ceil(26 / (W / monthCount)));
  const months = [];
  const m = parseKey(period.from);
  m.setUTCDate(1);
  m.setUTCMonth(m.getUTCMonth() + 1);
  for (let i = 0; m.getTime() < t1; i++) {
    const mon = m.getUTCMonth();
    // Month alone, never the year: "Jan 26" is twice the width the scale allows and
    // lands on February. The period is named in full at the top of the report. The last
    // tick of all loses its label rather than hang off the edge of the card.
    const mx = x(m.getTime());
    months.push({ x: mx, label: i % every === 0 && mx < W - 24 ? MONTHS[mon] : '' });
    m.setUTCMonth(mon + 1);
  }

  const laid = rows.map((u, r) => {
    const y = r * rowH;
    const cy = y + labelH;
    const sx = clamp(x(parseKey(spanStart(u)).getTime()));
    const ex = Math.max(sx + 3, clamp(x(parseKey(u.lastDay).getTime() + DAY_MS)));
    const blocks = [...weekly[r]].map(([ws, count]) => {
      const bx = clamp(x(ws));
      return { x: bx, w: Math.max(1.5, clamp(x(ws + 7 * DAY_MS)) - bx - 0.5), level: Math.max(1, levelOf(count, cuts)) };
    });
    const releases = u.releases.map((rel) => clamp(x(parseKey(rel.publishedAt).getTime() + DAY_MS / 2)));
    return { u, y, cy, sx, ex, born: u.isNew, blocks, releases };
  });

  return { W, H: rows.length * rowH, rowH, barH, labelH, headH, months, rows: laid, metric, cuts, portrait: true };
}

/**
 * The month scale on its own, so the page can pin it while the rows scroll past. It is
 * a separate element for exactly that reason — nothing inside one SVG can stay put
 * while the rest of it moves.
 */
export function ganttMonthsSVG(L) {
  const ticks = L.months.map((m) => `
    <line x1="${m.x.toFixed(1)}" y1="${L.headH - 5}" x2="${m.x.toFixed(1)}" y2="${L.headH}" stroke="${RULE}"/>
    ${m.label ? `<text class="g-axis" x="${(m.x + 3).toFixed(1)}" y="${L.headH - 8}">${m.label}</text>` : ''}`).join('');
  return `<svg class="gantt-axis" width="${L.W}" height="${L.headH}" viewBox="0 0 ${L.W} ${L.headH}" aria-hidden="true">${ticks}</svg>`;
}

/** The rows, under whatever the page has pinned above them. */
export function ganttPortraitSVG(L, { nameOf, resultOf }) {
  const grid = L.months.map((m) =>
    `<line x1="${m.x.toFixed(1)}" y1="0" x2="${m.x.toFixed(1)}" y2="${L.H}" stroke="${RULE}"/>`).join('');

  const rows = L.rows.map((r) => {
    const name = nameOf(r.u);
    const res = resultOf(r.u);
    const began = r.born ? `new, created ${fmtDay(r.u.createdDay)}` : `from ${fmtDay(r.u.firstDay)}`;
    const tipAttr = `data-tip="${esc(`${name} · ${fmtNum(r.u.commits)} commits · ${fmtNum(r.u.linesChanged)} lines · ${r.u.releases.length} releases · ${began} → ${fmtDay(r.u.lastDay)} · ${res.label}`)}"`;
    const blocks = r.blocks.map((b) =>
      `<rect ${tipAttr} x="${b.x.toFixed(1)}" y="${r.cy}" width="${b.w.toFixed(1)}" height="${L.barH}" rx="1.5" fill="${RAMP[b.level]}"/>`).join('');
    const releases = r.releases.map((rx) =>
      `<path ${tipAttr} d="M${rx.toFixed(1)} ${r.cy - 2.5}l3 3.5-3 3.5-3-3.5z" fill="${TOMATO}"/>`).join('');
    const ring = r.born
      ? `<circle ${tipAttr} cx="${r.sx.toFixed(1)}" cy="${r.cy + L.barH / 2}" r="3.2" fill="${CARD}" stroke="${INK}" stroke-width="1.4"/>`
      : '';
    return `<g class="g-row">
      <rect class="g-hit" x="0" y="${r.y}" width="${L.W}" height="${L.rowH}"/>
      <text class="g-name" x="0" y="${r.y + 10}">${esc(truncate(name, 30))}</text>
      <rect ${tipAttr} x="${r.sx.toFixed(1)}" y="${r.cy}" width="${(r.ex - r.sx).toFixed(1)}" height="${L.barH}" rx="${L.barH / 2}" fill="${RAMP[0]}"/>
      ${blocks}${releases}${ring}
    </g>`;
  }).join('');

  return `<svg class="gantt-rows" width="${L.W}" height="${L.H}" viewBox="0 0 ${L.W} ${L.H}" role="img" aria-label="Projects over time">${grid}${rows}</svg>`;
}

export function ganttSVG(L, { nameOf, resultOf }) {
  const grid = L.months.map((m) => `
    <line x1="${m.x.toFixed(1)}" y1="${L.headH - 6}" x2="${m.x.toFixed(1)}" y2="${L.H - 4}" stroke="${RULE}"/>
    ${m.label ? `<text class="g-axis" x="${m.x.toFixed(1)}" y="${L.headH - 10}" text-anchor="middle">${m.label}</text>` : ''}`).join('');

  const rows = L.rows.map((r) => {
    const name = nameOf(r.u);
    const res = resultOf(r.u);
    const mid = r.cy + L.barH / 2;
    const base = r.cy + L.barH - 1.5;
    const began = r.born ? `new, created ${fmtDay(r.u.createdDay)}` : `from ${fmtDay(r.u.firstDay)}`;
    const tipText = `${name} · ${fmtNum(r.u.commits)} commits · ${fmtNum(r.u.linesChanged)} lines · ${r.u.releases.length} releases · ${began} → ${fmtDay(r.u.lastDay)} · ${res.label}`;
    const tipAttr = `data-tip="${esc(tipText)}"`;
    // These sit on top of the track pill, so they need the tip as well or hovering a
    // block would fall through to no target at all.
    const blocks = r.blocks.map((b) =>
      `<rect ${tipAttr} x="${b.x.toFixed(1)}" y="${r.cy}" width="${b.w.toFixed(1)}" height="${L.barH}" rx="2" fill="${RAMP[b.level]}"/>`).join('');
    const releases = r.releases.map((rx) =>
      `<path ${tipAttr} d="M${rx.toFixed(1)} ${r.cy - 4}l3.5 4-3.5 4-3.5-4z" fill="${TOMATO}"/>`).join('');
    const ring = r.born
      ? `<circle ${tipAttr} cx="${r.sx.toFixed(1)}" cy="${mid}" r="4" fill="${CARD}" stroke="${INK}" stroke-width="1.6"/>`
      : '';
    // The tip belongs on the marks, not the row: hovering a name, an outcome label
    // or the count column should not explain the project, so tipAttr goes on each
    // thing that actually draws data and the hit area becomes the project's span.
    return `<g class="g-row">
      <rect class="g-hit" x="0" y="${r.y}" width="${L.W}" height="${L.rowH}"/>
      <text class="g-name" x="${L.trackX - 12}" y="${base}" text-anchor="end">${esc(truncate(name, 24))}</text>
      <rect ${tipAttr} x="${r.sx.toFixed(1)}" y="${r.cy}" width="${(r.ex - r.sx).toFixed(1)}" height="${L.barH}" rx="${L.barH / 2}" fill="${RAMP[0]}"/>
      ${blocks}${releases}${ring}
      ${statusDot(res, L.resultX, mid, 4)}
      <text class="g-result" x="${L.resultX + 10}" y="${base}">${esc(res.label)}</text>
      <text class="g-count" x="${L.W - 4}" y="${base}" text-anchor="end">${fmtNum(totalOf(r.u, L.metric))}</text>
    </g>`;
  }).join('');

  return `<svg class="gantt" viewBox="0 0 ${L.W} ${L.H}" role="img" aria-label="Projects over time">${grid}${rows}</svg>`;
}

