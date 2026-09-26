import { categoryOf, fmtBig, resultFor, unitName } from './model.js';
import { measure, svgText, x } from './svg.js';
import { GRAPHITE, INK, INK2, INK3 } from './theme.js';

/** Below half a percent, rounding would print "0%" for a real, non-zero quantity. */
const pct = (share) => (share >= 0.005 ? `${Math.round(share * 100)}%` : '<1%');
const plural = (n, noun) => `${noun}${n === 1 ? '' : 's'}`;


/** The "not filled in yet" buckets, which sort last within their tie group. */
const isUnfilled = (label) => /^(Unknown|Uncategorized)$/.test(label);

/**
 * One bucket per slice, before anything is sorted or coloured.
 *
 * Split by dimension because they count different things. An outcome or a category is
 * one vote per project. A language is weighted by the measure in play, across every
 * repository inside the project — a year of Rust and a one-file shell script are not
 * the same size, and a merged project can be several languages at once.
 */
function bucketsFor(units, story, dimension, metric) {
  const buckets = new Map();
  const add = (key, label) => {
    if (!buckets.has(key)) buckets.set(key, { key, label, count: 0, projects: [] });
    return buckets.get(key);
  };

  for (const unit of units) {
    const name = unitName(unit, story);
    if (dimension === 'result') {
      const r = resultFor(unit, story);
      const b = add(r.id || 'unset', r.label);
      b.count += 1;
      b.projects.push(name);
    } else if (dimension === 'language') {
      for (const repo of unit.members) {
        const weight = metric === 'commits' ? repo.commits : repo.linesChanged;
        if (!weight) continue;
        const b = add(repo.language || 'Unknown', repo.language || 'Unknown');
        b.count += weight;
        if (!b.projects.includes(name)) b.projects.push(name);
      }
    } else {
      const key = categoryOf(unit, story) || 'Uncategorized';
      const b = add(key, key);
      b.count += 1;
      b.projects.push(name);
    }
  }
  return buckets;
}

/**
 * Size first, then the not-filled-in bucket last within its tie group, then A-Z.
 * "Unknown" tying with a real language should not outrank it — the chart is a ranking,
 * and a gap in the data has not earned a place in it.
 */
function sortSlices(buckets) {
  return [...buckets.values()].sort((a, b) =>
    b.count - a.count
    || (isUnfilled(a.label) - isUnfilled(b.label))
    || a.label.localeCompare(b.label));
}

export function breakdownData(units, story, dimension, metric = 'lines') {
  const slices = sortSlices(bucketsFor(units, story, dimension, metric));
  const total = slices.reduce((n, b) => n + b.count, 0);
  // The noun has to follow the measure or the key row will say "lines" while counting
  // commits.
  const noun = dimension === 'language' ? (metric === 'commits' ? 'commit' : 'line') : 'project';
  return { slices, total, noun };
}

/**
 * The bar, as a bar.
 *
 * This was a 100% stacked bar per dimension, and it never earned the space: a dozen
 * languages became a row of slivers, the labels that fit were the three biggest, and
 * everything else went into an "Unlabeled:" line underneath that nobody reads. On a
 * phone it was a smear. A ranked horizontal bar gives every row its own name and its
 * own length, and it costs only height — the one dimension a page has to spare.
 */
const ROW_H = 28;        // row pitch: an 18px bar and 10px of air, which is the surface gap
const BAR_H = 18;        // under the 24px cap; the leftover in the band stays air
const BAR_R = 4;         // rounded at the data end, square on the baseline
const LABEL_GAP = 12;
const VALUE_GAP = 8;
const NAME_SIZE = 12.5;
const VALUE_SIZE = 12;
const MIN_BAR = 2;       // a real, non-zero quantity must leave a mark

/**
 * One colour, on every bar of both charts.
 *
 * The old ramp existed to tell adjacent segments of a single stacked bar apart. Separate
 * bars need no such help: length carries the value, the row's own name carries its
 * identity, and the two charts are told apart by their captions. So the colour here
 * encodes nothing, which is exactly why it should not vary — a second hue would imply a
 * second meaning and there isn't one. Graphite's third step, which clears 3:1 on the card.
 */
export const BAR_FILL = GRAPHITE[3];

/** As much of `text` as fits, with an ellipsis when it doesn't. */
function fit(text, size, room, weight = 400) {
  if (measure(text, weight, size) <= room) return text;
  let cut = text;
  while (cut.length > 1 && measure(`${cut}…`, weight, size) > room) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * Lay the chart out at a given width. Measuring happens here rather than in a DOM pass,
 * so the page and the exported image put every label in the same place — measuring
 * after render meant the two could never agree.
 */
export function layoutBars(data, { width, noun, fill }) {
  const max = Math.max(1, ...data.slices.map((s) => s.count));
  const total = Math.max(1, data.total);
  const rows = data.slices.map((slice) => ({
    name: slice.label,
    count: slice.count,
    value: fmtBig(slice.count),
    pct: pct(slice.count / total),
    tip: `${slice.label} · ${fmtBig(slice.count)} ${plural(slice.count, noun)} · ${pct(slice.count / total)}`,
  }));

  // The name column takes what the longest name needs, up to a share of the chart:
  // past that the bars have nowhere to be, so names are cut instead.
  const nameRoom = Math.max(64, Math.round(width * 0.34));
  const labelW = Math.min(nameRoom, Math.max(...rows.map((r) => measure(r.name, 400, NAME_SIZE))));
  const valueW = Math.max(...rows.map((r) => measure(`${r.value} (${r.pct})`, 400, VALUE_SIZE))) + 2;
  const x0 = labelW + LABEL_GAP;
  const track = Math.max(40, width - x0 - VALUE_GAP - valueW);

  for (const [i, row] of rows.entries()) {
    row.y = i * ROW_H;
    row.w = Math.max(MIN_BAR, (row.count / max) * track);
    row.label = fit(row.name, NAME_SIZE, labelW);
  }
  return { rows, width, height: rows.length * ROW_H, labelW, x0, fill };
}

/**
 * The chart as SVG. One renderer: the page inlines this markup and the export packs the
 * same fragments into its document, so a change to either shows up in both.
 */
export function barsSVG(L, { y = 0, interactive = true } = {}) {
  return `<g class="bars-g">${L.rows.map((row) => {
    const top = y + row.y + (ROW_H - BAR_H) / 2;
    const bar = `<path d="${roundedEnd(L.x0, top, row.w, BAR_H, BAR_R)}" fill="${L.fill}"/>`;
    const tip = interactive ? `<title>${x(row.tip)}</title>` : '';
    // Text wears text ink, never the bar's colour: the bar beside it carries identity.
    const name = svgText(row.label, L.labelW, top + BAR_H / 2 + 4,
      { size: NAME_SIZE, fill: INK, anchor: 'end' });
    const vx = L.x0 + row.w + VALUE_GAP;
    // The offset carries the space, never the string: SVG collapses a leading space, and
    // that is exactly how "30,071(1%)" got glued together the last time.
    const value = svgText(row.value, vx, top + BAR_H / 2 + 4, { size: VALUE_SIZE, fill: INK2 })
      + svgText(`(${row.pct})`, vx + measure(`${row.value} `, 400, VALUE_SIZE), top + BAR_H / 2 + 4,
        { size: VALUE_SIZE - 0.5, fill: INK3 });
    // The hit target is the whole row, not the bar: a 2px sliver cannot be hovered.
    const hit = interactive
      ? `<rect x="0" y="${y + row.y}" width="${L.width}" height="${ROW_H}" fill="transparent" data-tip="${x(row.tip)}"/>`
      : '';
    return `<g>${bar}${name}${value}${hit}${tip}</g>`;
  }).join('')}</g>`;
}

/** Square on the baseline it grows from, rounded at the end the data reaches. */
function roundedEnd(px, py, w, h, r) {
  const rr = Math.min(r, w);
  return `M${px.toFixed(2)},${py} H${(px + w - rr).toFixed(2)} A${rr},${rr} 0 0 1 ${(px + w).toFixed(2)},${(py + rr).toFixed(2)}`
    + ` V${(py + h - rr).toFixed(2)} A${rr},${rr} 0 0 1 ${(px + w - rr).toFixed(2)},${py + h} H${px.toFixed(2)} Z`;
}
