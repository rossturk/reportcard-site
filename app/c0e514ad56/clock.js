import { DAY_MS, esc, fmtBig, fmtNum, metricOf, parseKey, weightOf } from './model.js';
import { RAMP, levelOf, thresholds } from './heatmap.js';
import { GRAPHITE, RULE, TOMATO } from './theme.js';
import { measure } from './svg.js';

// Monday-first: a working week reads better than a calendar one.
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const isoDay = (date) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;

/**
 * An hour of the day, possibly fractional, as a 12-hour label: 15 is "3pm", 17.5 is
 * "5:30pm", 25 wraps to "1am". Rounded to the minute first and split after, so 3.999
 * carries to "4am" — splitting first rounded the minutes alone and printed "3:60am".
 */
export const fmtHour = (h) => {
  const total = ((Math.round(h * 60) % 1440) + 1440) % 1440;
  const hour = Math.floor(total / 60);
  const mins = total % 60;
  const suffix = hour < 12 ? 'am' : 'pm';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return mins ? `${display}:${String(mins).padStart(2, '0')}${suffix}` : `${display}${suffix}`;
};

/** Hour with the least activity, smoothed over three hours so a single empty hour can't win. */
function quietHour(hours) {
  let best = 0;
  let low = Infinity;
  for (let h = 0; h < 24; h++) {
    const run = hours[(h + 23) % 24] + hours[h] + hours[(h + 1) % 24];
    if (run < low) {
      low = run;
      best = h;
    }
  }
  return best;
}

/**
 * Commit clock for the included projects: a weekday x hour matrix, hour and weekday
 * totals, and a working schedule inferred from when each active day starts and ends.
 */
export function clockModel(stats, metric = 'commits') {
  const matrix = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const byHour = new Array(24).fill(0);
  const byWeekday = new Array(7).fill(0);
  // Sessions answer "when did you work", so they count commits whatever the measure is.
  const commitsByHour = new Array(24).fill(0);
  const perDay = new Map();
  let total = 0;
  let commitTotal = 0;

  for (const unit of stats.included) {
    for (const [date, list] of Object.entries(unit.entries || {})) {
      if (date < stats.period.from || date > stats.period.to) continue;
      const row = isoDay(date);
      for (const entry of list) {
        const [h] = entry;
        const weight = weightOf(entry, metric);
        matrix[row][h] += weight;
        byHour[h] += weight;
        byWeekday[row] += weight;
        total += weight;
        commitsByHour[h] += 1;
        commitTotal += 1;
        // Sessions are about when you worked, so they count commits either way.
        if (!perDay.has(date)) perDay.set(date, []);
        perDay.get(date).push(h);
      }
    }
  }

  let weekendDays = 0;
  for (const [date, hours] of perDay) {
    hours.sort((a, b) => a - b);
    if (isoDay(date) >= 5) weekendDays += 1;
  }


  // Both bands come from one distribution, measured in hours since your quietest hour so
  // a window that crosses midnight stays contiguous. Percentile bands nest by
  // construction: the busy half always sits inside the working 80%.
  const quiet = quietHour(commitsByHour);
  const offsetOf = (h) => (h - quiet + 24) % 24;
  const toClock = (offset) => (offset == null ? null : (quiet + offset) % 24);

  const spread = new Array(24).fill(0);
  for (let h = 0; h < 24; h++) spread[offsetOf(h)] = byHour[h];

  /** Offset where the cumulative distribution crosses `p`, interpolated within the hour. */
  const percentile = (p) => {
    if (!total) return null;
    const target = total * p;
    let seen = 0;
    for (let offset = 0; offset < 24; offset++) {
      const next = seen + spread[offset];
      if (next >= target) return offset + (spread[offset] ? (target - seen) / spread[offset] : 0);
      seen = next;
    }
    return 23;
  };

  // Round to the half hour: the source data only knows which hour a commit landed in,
  // so "5:21pm" would claim a precision that isn't there.
  const half = (offset) => (offset == null ? null : Math.round(offset * 2) / 2);
  const band = (lo, hi) => ({
    from: toClock(half(percentile(lo))),
    to: toClock(half(percentile(hi))),
    share: hi - lo,
  });
  const workingWindow = band(0.1, 0.9);
  const core = band(0.25, 0.75);

  const activeDays = perDay.size;
  const weeks = Math.max(1, stats.totals.days / 7);
  const share = (n) => (total ? n / total : 0);

  return {
    matrix,
    byHour,
    byWeekday,
    total,
    noun: metricOf(metric).noun,
    activeDays,
    schedule: {
      window: workingWindow,
      core,
      quiet,
      peakHour: byHour.indexOf(Math.max(...byHour)),
      peakDay: byWeekday.indexOf(Math.max(...byWeekday)),
      weekendShare: share(byWeekday[5] + byWeekday[6]),
      nightShare: share([22, 23, 0, 1, 2, 3, 4, 5].reduce((n, h) => n + byHour[h], 0)),
      officeShare: share([9, 10, 11, 12, 13, 14, 15, 16].reduce((n, h) => n + byHour[h], 0)),
      daysPerWeek: activeDays / weeks,
      weekendDays,
    },
  };
}

/* ------------------------------------------------------------------ dial */

const TAU = Math.PI * 2;
// Midnight at the top, clockwise, like a clock face.
const angleOf = (hour) => (hour / 24) * TAU - Math.PI / 2;
const polar = (cx, cy, r, a) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];

/** Closed Catmull-Rom through the 24 hour points, as cubic beziers. */
function smoothClosed(points) {
  const n = points.length;
  const segs = [];
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    segs.push({
      c1: [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
      c2: [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6],
      to: p2,
    });
  }
  return segs;
}

const segPath = (start, segs) =>
  `M${start[0].toFixed(1)},${start[1].toFixed(1)}`
  + segs.map((s) => `C${s.c1[0].toFixed(1)},${s.c1[1].toFixed(1)} ${s.c2[0].toFixed(1)},${s.c2[1].toFixed(1)} ${s.to[0].toFixed(1)},${s.to[1].toFixed(1)}`).join('')
  + 'Z';

export function layoutDial(model, { size = 260, pad = 42 } = {}) {
  const cx = size / 2;
  const cy = size / 2;
  const rMax = size / 2 - pad;
  const rMin = rMax * 0.26;
  const max = Math.max(1, ...model.byHour);
  // Radius by square root, so a wedge's area tracks its share.
  const radius = (v) => rMin + (rMax - rMin) * Math.sqrt(v / max);

  const points = model.byHour.map((v, h) => polar(cx, cy, radius(v), angleOf(h)));
  const segs = smoothClosed(points);
  const marks = model.byHour.map((v, h) => {
    const [x, y] = polar(cx, cy, radius(v), angleOf(h));
    return { x, y, hour: h, count: v, peak: h === model.schedule.peakHour };
  });

  const arc = (edge, radius) => {
    const span = (edge.to - edge.from + 24) % 24 || 24;
    const a = polar(cx, cy, radius, angleOf(edge.from));
    const b = polar(cx, cy, radius, angleOf(edge.from + span));
    return {
      d: `M${a[0].toFixed(1)},${a[1].toFixed(1)}A${radius.toFixed(1)},${radius.toFixed(1)} 0 ${span > 12 ? 1 : 0} 1 ${b[0].toFixed(1)},${b[1].toFixed(1)}`,
      cx, cy, r: radius, from: angleOf(edge.from), to: angleOf(edge.from + span),
    };
  };

  return {
    size, cx, cy, rMax, rMin,
    rings: [0.5, 1].map((f) => ({ r: rMin + (rMax - rMin) * f, value: Math.round(max * f * f) })),
    spokes: [0, 6, 12, 18].map((h) => ({
      inner: polar(cx, cy, rMin - 4, angleOf(h)),
      outer: polar(cx, cy, rMax + 4, angleOf(h)),
      label: fmtHour(h),
      at: polar(cx, cy, rMax + 28, angleOf(h)),
    })),
    path: segPath(points[0], segs),
    start: points[0],
    segs,
    marks,
    window: arc(model.schedule.window, rMax + 16),
    core: arc(model.schedule.core, rMax + 9),
  };
}

export function dialSVG(L, model) {
  const rings = L.rings.map((r) => `<circle cx="${L.cx}" cy="${L.cy}" r="${r.r.toFixed(1)}" fill="none" stroke="${RULE}"/>`).join('');
  const spokes = L.spokes.map((s) => `
    <line x1="${s.inner[0].toFixed(1)}" y1="${s.inner[1].toFixed(1)}" x2="${s.outer[0].toFixed(1)}" y2="${s.outer[1].toFixed(1)}" stroke="${RULE}"/>
    <text class="k-hour" x="${s.at[0].toFixed(1)}" y="${(s.at[1] + 4).toFixed(1)}" text-anchor="middle">${s.label}</text>`).join('');
  const marks = L.marks.map((m) => `<circle class="k-dot${m.peak ? ' peak' : ''}" cx="${m.x.toFixed(1)}" cy="${m.y.toFixed(1)}" r="${m.peak ? 4 : 2.2}"
    data-tip="${esc(`${fmtHour(m.hour)} – ${fmtHour(m.hour + 1)} · ${fmtNum(m.count)} ${model.noun}`)}"/>`).join('');
  return `<svg class="dial" viewBox="0 0 ${L.size} ${L.size}" role="img" aria-label="Commits by hour of day">
    ${rings}${spokes}
    <path d="${L.path}" fill="${GRAPHITE[4]}" fill-opacity="0.08" stroke="${GRAPHITE[3]}" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="${L.window.d}" fill="none" stroke="${GRAPHITE[2]}" stroke-width="1.5" stroke-linecap="round"/>
    <path d="${L.core.d}" fill="none" stroke="${TOMATO}" stroke-width="3.5" stroke-linecap="round"/>
    ${marks}
  </svg>`;
}

/* ---------------------------------------------------------------- matrix */

export function layoutMatrix(model, { W = 700, labelW, barW = 46, numW = 44, cell, gap = 3, headH = 18 } = {}) {
  // Weekday labels are right-anchored 9px inside the gutter, so the gutter has to hold
  // the widest of them or they run off the left edge -- invisible on the page, clipped
  // in the export, where the matrix is a nested <svg> with its own viewport.
  if (labelW == null) labelW = Math.ceil(Math.max(...WEEKDAYS.map((d) => measure(d, 700, 12)))) + 13;
  // Reserve the weekday bar and its number before sizing cells, or the totals get clipped.
  const totalsW = 10 + barW + 8 + numW;
  const size = cell || Math.max(10, Math.floor((W - labelW - totalsW - gap * 23) / 24));
  const step = size + gap;
  const cuts = thresholds(model.matrix.flat());
  const maxDay = Math.max(1, ...model.byWeekday);

  const cells = [];
  model.matrix.forEach((row, r) => {
    row.forEach((count, h) => {
      cells.push({
        x: labelW + h * step, y: headH + r * step, w: size, h: size,
        count, level: levelOf(count, cuts), hour: h, day: r,
      });
    });
  });

  const barX = labelW + 24 * step - gap + 12;
  const width = barX + barW + 8 + numW;
  return {
    W: width, H: headH + 7 * step - gap + 4, size, step, labelW, headH, cuts, barX, barW,
    cells,
    rows: WEEKDAYS.map((label, r) => ({
      label, y: headH + r * step + size - 2,
      barY: headH + r * step + 1, barH: size - 2,
      bar: (model.byWeekday[r] / maxDay) * barW,
      total: model.byWeekday[r],
      weekend: r >= 5,
    })),
    hours: [0, 6, 12, 18].map((h) => ({ label: fmtHour(h), x: labelW + h * step })),
  };
}

export function matrixSVG(L, model) {
  const cells = L.cells.map((c) => `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="${Math.min(3, c.w / 4)}" fill="${RAMP[c.level]}"
    data-tip="${esc(`${WEEKDAYS[c.day]} ${fmtHour(c.hour)} · ${fmtNum(c.count)} ${model.noun}`)}"/>`).join('');
  const rows = L.rows.map((r) => `
    <text class="k-day${r.weekend ? ' weekend' : ''}" x="${L.labelW - 9}" y="${r.y}" text-anchor="end">${r.label}</text>
    <rect x="${L.barX}" y="${r.barY}" width="${Math.max(1, r.bar).toFixed(1)}" height="${r.barH}" rx="2" fill="${GRAPHITE[r.weekend ? 2 : 3]}"/>
    <text class="k-total" x="${L.barX + L.barW + 8}" y="${r.y}">${fmtBig(r.total)}</text>`).join('');
  const hours = L.hours.map((h) => `<text class="k-hour" x="${h.x}" y="${L.headH - 7}">${h.label}</text>`).join('');
  return `<svg class="matrix" viewBox="0 0 ${L.W} ${L.H}" role="img" aria-label="Commits by weekday and hour">${hours}${cells}${rows}</svg>`;
}

/**
 * The same grid, turned on its side for a narrow screen.
 *
 * 24 hours across needs 700px before the cells stop being slivers, so on a phone the
 * wide grid is a sideways scroll through the one chart whose whole point is the shape
 * you see at a glance. Turned, the week is seven columns — which is exactly what a
 * phone is shaped for — and the day runs down the page, midnight at the top.
 *
 * The per-weekday totals move from a bar at the right to a number under each column:
 * the same figures, in the direction the grid now runs.
 */
export function layoutMatrixPortrait(model, { W = 330, gap = 3, headH = 16, footH = 16 } = {}) {
  // The hour labels sit in a gutter on the left, and the same gutter is left empty on
  // the right. Centre the whole block instead and the grid — which is all the eye sees
  // — lands off centre by half the labels' width. Balancing it here rather than nudging
  // the element sideways means the labels can never hang off the card on a narrow one.
  const labelW = Math.ceil(Math.max(...['12am', '12pm'].map((h) => measure(h, 400, 10.5)))) + 8;
  // Capped: a seventh of a phone is a 42px cell, which is far more than a square of
  // colour needs and makes the card a thousand pixels tall for one chart.
  const size = Math.max(9, Math.min(28, Math.floor((W - labelW * 2 - gap * 6) / 7)));
  const step = size + gap;
  const cuts = thresholds(model.matrix.flat());

  const cells = [];
  model.matrix.forEach((row, r) => {
    row.forEach((count, h) => {
      cells.push({
        x: labelW + r * step, y: headH + h * step, w: size, h: size,
        count, level: levelOf(count, cuts), hour: h, day: r,
      });
    });
  });

  return {
    W: labelW * 2 + 7 * step - gap, H: headH + 24 * step - gap + footH,
    size, step, labelW, headH, cuts, cells, portrait: true,
    days: WEEKDAYS.map((label, r) => ({
      label: label[0], full: label, weekend: r >= 5,
      x: labelW + r * step + size / 2,
      total: model.byWeekday[r],
    })),
    // Every six hours, which is as many as the column can name without crowding.
    hours: [0, 6, 12, 18].map((h) => ({ label: fmtHour(h), y: headH + h * step + size - 2 })),
    footY: headH + 24 * step - gap + 12,
  };
}

/** The turned grid as SVG. Page only: the exported image is always wide enough for the other one. */
export function matrixPortraitSVG(L, model) {
  const cells = L.cells.map((c) => `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="${Math.min(3, c.w / 4)}" fill="${RAMP[c.level]}"
    data-tip="${esc(`${WEEKDAYS[c.day]} ${fmtHour(c.hour)} · ${fmtNum(c.count)} ${model.noun}`)}"/>`).join('');
  const days = L.days.map((d) => `
    <text class="k-day${d.weekend ? ' weekend' : ''}" x="${d.x}" y="${L.headH - 5}" text-anchor="middle">${d.label}</text>
    <text class="k-total" x="${d.x}" y="${L.footY}" text-anchor="middle">${fmtBig(d.total)}</text>`).join('');
  const hours = L.hours.map((h) => `<text class="k-hour" x="0" y="${h.y}">${h.label}</text>`).join('');
  // Width and height, not just a viewBox: with a viewBox alone the browser stretches
  // the grid to the container and the cell cap means nothing.
  return `<svg class="matrix portrait" width="${L.W}" height="${L.H}" viewBox="0 0 ${L.W} ${L.H}"`
    + ` role="img" aria-label="Commits by weekday and hour">${hours}${cells}${days}</svg>`;
}

/** One-line readings of the schedule, for the card and the exported image. */
export function scheduleFacts(model) {
  const s = model.schedule;
  if (!model.total) return [];
  const pct = (v) => `${Math.round(v * 100)}%`;
  return [
    // A closed-up en dash, the way the Nights note already writes 10pm-6am: it is the
    // usual form for a range, it matches its neighbour, and it gives "5:30pm-1:30am"
    // no place to break — spaced, it wrapped onto two lines in a narrow tile and left
    // that tile taller than the four beside it.
    { label: 'Working window', value: `${fmtHour(s.window.from)}–${fmtHour(s.window.to)}`, note: `where ${pct(s.window.share)} of ${model.noun} land` },
    { label: 'Busiest stretch', value: `${fmtHour(s.core.from)}–${fmtHour(s.core.to)}`, note: `the middle ${pct(s.core.share)}` },
    { label: 'Peak hour', value: fmtHour(s.peakHour), note: `busiest on ${WEEKDAYS[s.peakDay]}` },
    { label: 'Days per week', value: s.daysPerWeek.toFixed(1), note: `${pct(s.weekendShare)} on weekends` },
    { label: 'Nights', value: pct(s.nightShare), note: `10pm–6am\u2002·\u2002${pct(s.officeShare)} in 9–5` },
  ];
}
