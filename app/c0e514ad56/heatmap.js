import { MONTHS, parseKey, daysBetween } from './model.js';
import { FONT, GRAPHITE, INK3 } from './theme.js';
import { measure, svgText, x } from './svg.js';

// Sequential single-hue ramp, light -> dark; step 0 is "nothing" and recedes into the surface.
export const RAMP = GRAPHITE;

/** Cut points fitted to this person's rhythm: quartiles of the non-zero values. */
export function thresholds(counts) {
  const active = counts.filter((c) => c > 0).sort((a, b) => a - b);
  if (!active.length) return [1, 2, 3, 4];
  const at = (q) => active[Math.min(active.length - 1, Math.floor(active.length * q))];
  return [1, at(0.4), at(0.7), at(0.9)].reduce((out, v, i) => {
    out.push(i === 0 ? 1 : Math.max(v, out[i - 1] + 1));
    return out;
  }, []);
}

export function levelOf(count, cuts) {
  if (count <= 0) return 0;
  if (count < cuts[1]) return 1;
  if (count < cuts[2]) return 2;
  if (count < cuts[3]) return 3;
  return 4;
}

/** `calendar` is one entry per day, in order. Columns are Sunday-started weeks. */
export function layoutHeatmap(calendar, { cell = 13, gap = 3, padTop = 20, padLeft = 32 } = {}) {
  const step = cell + gap;
  const cuts = thresholds(calendar.map((c) => c.count));
  const offset = calendar.length ? parseKey(calendar[0].date).getUTCDay() : 0;
  const cells = calendar.map((c, i) => {
    const col = Math.floor((i + offset) / 7);
    const row = (i + offset) % 7;
    return {
      x: padLeft + col * step, y: padTop + row * step, w: cell, h: cell, col,
      date: c.date, count: c.count, level: levelOf(c.count, cuts),
    };
  });
  const cols = calendar.length ? Math.floor((calendar.length - 1 + offset) / 7) + 1 : 0;
  const months = cells
    .filter((c) => c.date.slice(8) === '01')
    .map((c) => ({ x: c.x, label: MONTHS[parseKey(c.date).getUTCMonth()] }));
  const rows = [['Mon', 1], ['Wed', 3], ['Fri', 5]].map(([label, r]) => ({ label, y: padTop + r * step + cell - 2 }));
  return { cells, months, rows, cuts, padTop, width: padLeft + cols * step - gap, height: padTop + 7 * step - gap };
}

/**
 * The heatmap as SVG. Same geometry the canvas painter used, so the grid, labels and
 * ramp are identical whether this lands in the page or in the exported image — the
 * whole point of having one renderer.
 */
export function heatmapSVG(L, { size = 11, tip = null } = {}) {
  const months = L.months.map((m) => svgText(m.label, m.x, L.padTop - 7, { size, fill: INK3 })).join('');
  const rows = L.rows.map((r) => svgText(r.label, 0, r.y, { size, fill: INK3 })).join('');
  // A `tip` formatter turns each cell into its own hover target, so the page needs no
  // coordinate hit-testing; the export passes none and gets inert rects.
  const cells = L.cells.map((c) => {
    const r = Math.min(2.5, c.w / 4);
    const attr = tip ? ` data-tip="${x(tip(c))}"` : '';
    return `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="${r}" fill="${RAMP[c.level]}"${attr}/>`;
  }).join('');
  return `<g class="heat">${months}${rows}${cells}</g>`;
}

/**
 * The year as a stack of months, for a screen that is taller than it is wide.
 *
 * The long grid is 53 weeks across, which on a phone is three and a half screens of
 * sideways scrolling to read one year. Cut into months it is a wall calendar: weekdays
 * across, weeks down, two months to a row, and the whole thing scrolls the way the page
 * already scrolls. The shade means exactly what it means in the wide version — the cuts
 * come from the same thresholds — so the two are the same chart in different clothes.
 */
export function monthBlocksHTML(calendar, { width = 320, gap = 3, columns = 2, gutter = 20, tip = null } = {}) {
  const cuts = thresholds(calendar.map((c) => c.count));
  // Size the cell so the columns land flush with the card's own padding. Sized by hand
  // instead, the leftover width collects in the gutter and the pair stops reading as a
  // pair — more air between the two months than between the days inside one.
  const room = width - gutter * (columns - 1) - columns * 6 * gap;
  const cell = Math.max(11, Math.min(24, Math.floor(room / (columns * 7))));
  const step = cell + gap;
  const byMonth = new Map();
  for (const day of calendar) {
    const key = day.date.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(day);
  }

  // Every block is six weeks tall whether its month needs six or four. A calendar month
  // is 4 to 6 rows, and letting each block take only what it needs makes the gap under
  // every label a different size — the page reads as though it were badly set rather
  // than as though February is short.
  const h = 6 * step - gap;

  const blocks = [...byMonth].map(([key, days]) => {
    // Where the first of the month falls in its week decides the whole block's shape.
    const lead = parseKey(`${key}-01`).getUTCDay();
    const label = MONTHS[Number(key.slice(5, 7)) - 1] + (key.slice(5, 7) === '01' ? ` ${key.slice(0, 4)}` : '');
    const cells = days.map((day) => {
      const i = lead + Number(day.date.slice(8)) - 1;
      const attr = tip ? ` data-tip="${x(tip(day))}"` : '';
      return `<rect x="${(i % 7) * step}" y="${Math.floor(i / 7) * step}" width="${cell}" height="${cell}"`
        + ` rx="${Math.min(2.5, cell / 4)}" fill="${RAMP[levelOf(day.count, cuts)]}"${attr}/>`;
    }).join('');
    const w = 7 * step - gap;
    return `<figure class="month"><figcaption>${label}</figcaption>`
      + `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${cells}</svg></figure>`;
  }).join('');

  return { markup: `<div class="months">${blocks}</div>`, cuts };
}

/**
 * The ramp as an index: each shade beside the range it stands for. Cut points come from
 * the data, so the bands are this person's own rhythm rather than a fixed scale.
 */
export function rampLegendSVG(cuts, noun, { y = 0, size = 12, zero = 'none', unit = 'in a day', fmt = (n) => String(n), tail = '' } = {}) {
  const band = (lo, hi) => (lo >= hi ? fmt(lo) : `${fmt(lo)}\u2013${fmt(hi)}`);
  const bands = [
    ...(zero ? [[RAMP[0], zero]] : []),
    [RAMP[1], band(1, cuts[1] - 1)],
    [RAMP[2], band(cuts[1], cuts[2] - 1)],
    [RAMP[3], band(cuts[2], cuts[3] - 1)],
    [RAMP[4], `${fmt(cuts[3])}+`],
  ];
  let cx = 0;
  const out = bands.map(([hex, label]) => {
    const chip = `<rect x="${cx}" y="${y}" width="12" height="12" rx="2.5" fill="${hex}"/>`;
    const text = svgText(label, cx + 17, y + 10, { size, fill: INK3 });
    cx += 17 + measure(label, 400, size) + 14;
    return chip + text;
  }).join('');
  // A second key can ride the same line — the gantt's glyphs do. The gap lives in the
  // offset, not in the string: SVG collapses a leading space.
  const note = `${noun} ${unit}`;
  const tailX = cx + 2 + measure(note, 400, size) + 18;
  return {
    markup: out + svgText(note, cx + 2, y + 10, { size, fill: INK3 })
      + (tail ? svgText(tail, tailX, y + 10, { size, fill: INK3 }) : ''),
    height: 18,
  };
}

export function paintHeatmap(ctx, L, { x = 0, y = 0, size = 10 } = {}) {
  ctx.save();
  ctx.translate(x, y);
  ctx.font = `${size}px ${FONT}`;
  ctx.fillStyle = INK3;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  for (const m of L.months) ctx.fillText(m.label, m.x, L.padTop - 7);
  for (const r of L.rows) ctx.fillText(r.label, 0, r.y);
  for (const c of L.cells) {
    ctx.fillStyle = RAMP[c.level];
    ctx.beginPath();
    ctx.roundRect(c.x, c.y, c.w, c.h, Math.min(2.5, c.w / 4));
    ctx.fill();
  }
  ctx.restore();
}

/** Draws into a canvas sized to the grid at device resolution. Returns the layout for hit-testing. */
export function drawHeatmap(canvas, calendar, opts = {}) {
  const L = layoutHeatmap(calendar, opts);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.ceil(L.width * dpr);
  canvas.height = Math.ceil(L.height * dpr);
  canvas.style.width = `${L.width}px`;
  canvas.style.height = `${L.height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, L.width, L.height);
  paintHeatmap(ctx, L, opts);
  return L;
}

/** Weekly commit bars across the period, for table rows. */
export function sparklineSVG(days, { from, to }) {
  const weeks = Math.max(1, Math.ceil((daysBetween(from, to) + 1) / 7));
  const buckets = new Array(weeks).fill(0);
  for (const [day, count] of Object.entries(days)) {
    if (day < from || day > to) continue;
    buckets[Math.min(weeks - 1, Math.floor(daysBetween(from, day) / 7))] += count;
  }
  const max = Math.max(1, ...buckets);
  const W = 100;
  const H = 24;
  const bw = W / weeks;
  const bars = buckets.map((v, i) => {
    if (!v) return '';
    const h = Math.max(1.5, (v / max) * H);
    return `<rect x="${(i * bw).toFixed(2)}" y="${(H - h).toFixed(2)}" width="${Math.max(0.5, bw - 0.35).toFixed(2)}" height="${h.toFixed(2)}" fill="${RAMP[3]}"/>`;
  }).join('');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>`;
}
