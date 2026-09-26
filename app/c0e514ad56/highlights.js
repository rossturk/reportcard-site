/**
 * Project highlights, as SVG.
 *
 * The page used HTML here and the export drew its own reduced version, which is why the
 * image never carried the stat row. One renderer now: the page inlines this markup and the
 * export packs the same fragments in, so a change to either shows up in both.
 *
 * Image sources arrive pre-resolved — a plain URL for the page, a data URI for the export,
 * because detached markup never fetches external files.
 */
import { categoryOf, descriptionOf, fmtBig, fmtNum, linkLabel, linkOf, meta, resultFor, unitName } from './model.js';
import { INK, INK2, INK3, RULE, RULE_STRONG } from './theme.js';
import { measure, statusDot, svgRect, svgRuns, svgText, wrapRuns, wrapWords, x } from './svg.js';

const SHOT_W = 340;
const SHOT_MAX_H = 240;
const PAD = 16;
const GAP = 18;
// Under this much room a description reads one word per line and the title collides
// with its result chip, so the screenshot goes above the text instead of beside it.
// The exported image is always far wider than this; only a narrow page ever stacks.
const MIN_TEXT = 300;
// Stat values: drawn and measured at the same weight, or the column is sized for
// text that isn't there. Matches .kpi-value / .fact b on the page.
const STAT_WEIGHT = 400;

const statsFor = (unit, story) => {
  const langs = unit.languages || [];
  const out = [
    ['Commits', fmtNum(unit.commits)],
    ['Lines', fmtBig(unit.linesChanged)],
    ['Releases', String(unit.releases.length)],
  ];
  if (langs.length) {
    out.push([langs.length > 1 ? 'Languages' : 'Language',
      langs.slice(0, 3).map((l) => l.name).join(', ') + (langs.length > 3 ? ` +${langs.length - 3}` : '')]);
  }
  const cat = categoryOf(unit, story);
  if (cat) out.push(['Category', cat]);
  return out;
};

/**
 * Measure one highlight against a width. Done before drawing so the page and the export
 * agree on height, and so the export can total the image before it paints.
 */
export function layoutHighlight(unit, story, { width, shot = null }) {
  const name = unitName(unit, story);
  const res = resultFor(unit, story);
  const note = meta(story, unit.key).note?.trim() || '';
  const desc = descriptionOf(unit, story);
  const body = desc || note;
  const hasShot = Boolean(shot);
  const inner = width - PAD * 2;
  const stacked = hasShot && inner - SHOT_W - GAP < MIN_TEXT;
  // Stacked, the shot takes the column it is given rather than its own fixed width —
  // a 340px screenshot does not fit a phone.
  const shotW = hasShot ? Math.min(SHOT_W, inner) : 0;
  const textW = hasShot && !stacked ? inner - SHOT_W - GAP : inner;

  const resW = measure(res.label, 400, 12) + 15;
  const nameLines = wrapWords(name, { weight: 700, size: 17, room: textW - resW - 10 }) || [name];
  // The link closes the tile on one line; a long one loses its tail, not its host.
  const href = linkOf(unit, story);
  let linkText = href ? `${linkLabel(href)} ↗` : '';
  if (linkText && measure(linkText, 400, 13) > textW) {
    let cut = linkLabel(href);
    while (cut.length > 1 && measure(`${cut}… ↗`, 400, 13) > textW) cut = cut.slice(0, -1);
    linkText = `${cut}… ↗`;
  }
  // The description takes the same inline markup as the report's prose; any newline in
  // it is a paragraph break, since its textarea shows no gap to type a blank line into.
  const descLines = wrapRuns(body, { size: 13.5, room: textW, breaks: /\r?\n+/ });
  const noteLines = desc && note ? (wrapWords(note, { size: 13, room: textW - 10 }) || []) : [];
  const stats = statsFor(unit, story);

  // Stats wrap into rows of whatever fits, each column sized to its own content.
  const cols = stats.map(([label, value]) => ({
    label, value,
    w: Math.max(measure(label.toUpperCase(), 400, 10.5) + 1.5, measure(value, STAT_WEIGHT, 15)) + 18,
  }));
  const rows = [];
  let row = [];
  let used = 0;
  for (const col of cols) {
    if (used + col.w > textW && row.length) { rows.push(row); row = []; used = 0; }
    row.push(col);
    used += col.w;
  }
  if (row.length) rows.push(row);

  const textH = nameLines.length * 22
    + (descLines.length ? 8 + descLines.length * 20 : 0)
    + (noteLines.length ? 6 + noteLines.length * 19 : 0)
    + 12 + rows.length * 38
    + (linkText ? 22 : 0);
  const shotH = hasShot ? Math.min(SHOT_MAX_H, Math.round(shotW * shot.ratio)) : 0;
  // Side by side the tile is as tall as its tallest column; stacked they add up.
  const height = stacked
    ? shotH + GAP + textH + PAD * 2
    : Math.max(textH + PAD * 2, hasShot ? shotH + PAD * 2 : 0);
  return {
    unit, name, res, nameLines, href, linkText, descLines, noteLines, rows, hasShot, shot, shotH, shotW,
    stacked, width, height, textW, isPlaceholder: !body,
  };
}

/** One highlight tile. */
export function highlightSVG(L, { y = 0 } = {}) {
  const tx = PAD + (L.hasShot && !L.stacked ? L.shotW + GAP : 0);

  const shot = L.hasShot
    ? `<clipPath id="${L.shot.id}"><rect x="${PAD}" y="${y + PAD}" width="${L.shotW}" height="${L.shotH}" rx="9"/></clipPath>`
      + `<image href="${L.shot.href}" x="${PAD}" y="${y + PAD}" width="${L.shotW}" height="${L.shotH}"`
      + ` preserveAspectRatio="xMidYMin slice" clip-path="url(#${L.shot.id})"/>`
    : '';

  // Stacked, the text starts below the screenshot rather than beside it.
  const top = y + PAD + (L.stacked ? L.shotH + GAP : 0);
  let ty = top + 16;
  const name = L.nameLines.map((line) => {
    const out = svgText(line, tx, ty, { size: 17, weight: 700, fill: INK });
    ty += 22;
    return out;
  }).join('');

  const chipX = L.width - PAD;
  const chip = statusDot(L.res, chipX - measure(L.res.label, 400, 12) - 13, top + 11, 4.5)
    + svgText(L.res.label, chipX, top + 15, { size: 12, fill: INK3, anchor: 'end' });

  let dy = ty + (L.descLines.length ? 2 : 0);
  const desc = L.descLines.map((line) => {
    const out = line.length ? svgRuns(line, tx, dy + 14, { size: 13.5, fill: L.isPlaceholder ? INK3 : INK2 }) : '';
    dy += 20;
    return out;
  }).join('');

  let ny = dy + (L.noteLines.length ? 6 : 0);
  const noteTop = ny;
  const note = L.noteLines.map((line) => {
    const out = svgText(line, tx + 10, ny + 14, { size: 13, fill: INK3 });
    ny += 19;
    return out;
  }).join('');
  const noteRule = L.noteLines.length
    ? svgRect(tx, noteTop + 2, 2, ny - noteTop - 2, { fill: RULE_STRONG })
    : '';

  let sy = ny + 12;
  const stats = L.rows.map((row) => {
    let sx = tx;
    const out = row.map((col) => {
      const cell = svgText(col.label.toUpperCase(), sx, sy + 10, { size: 10.5, fill: INK3 })
        + svgText(col.value, sx, sy + 28, { size: 15, weight: STAT_WEIGHT, fill: INK });
      sx += col.w;
      return cell;
    }).join('');
    sy += 38;
    return out;
  }).join('');

  // A real anchor on the page and the exported site; in the PNG it is only its text.
  const link = L.linkText
    ? `<a href="${x(L.href)}" target="_blank" rel="noopener" class="hl-link">`
      + `${svgText(L.linkText, tx, sy + 18, { size: 13, fill: INK2 })}</a>`
    : '';

  return `<g class="hl-g">${shot}${name}${chip}${desc}${noteRule}${note}${stats}${link}</g>`;
}

/** The whole section: tiles stacked with a gap, total height reported back. */
export function highlightsSVG(units, story, { width, sources = new Map(), y = 0, gap = 14 } = {}) {
  let cursor = y;
  const parts = units.map((unit, i) => {
    const src = meta(story, unit.key).image;
    const found = src ? sources.get(src) : null;
    const shot = found ? { href: found.href, id: `hlshot${i}`, ratio: found.ratio } : null;
    const L = layoutHighlight(unit, story, { width, shot });
    let markup = highlightSVG(L, { y: cursor });
    cursor += L.height;
    // A hairline between neighbours, never after the last one. Centred in the gap, and
    // half-pixel aligned so it renders as one crisp line rather than two grey ones.
    if (i < units.length - 1) {
      markup += svgRect(0, Math.round(cursor + gap / 2) + 0.5, width, 1, { fill: RULE });
    }
    cursor += gap;
    return markup;
  }).join('');
  return { markup: parts, height: Math.max(0, cursor - y - gap) };
}
