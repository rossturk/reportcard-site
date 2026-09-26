/**
 * The exported image.
 *
 * Nothing is drawn twice any more. Every section here is the same SVG the dashboard
 * renders; this module only decides where each one sits and how tall the page is, then
 * rasterises the result. A tweak to a chart lands in both places because it is literally
 * the same call — the old canvas painters were a second implementation that drifted.
 */
import {
  KPIS, PROMPTS, SECTION_ORDER, delta, fmtBig, fmtTight, fmtNum, fmtRange, introFor, isHighlighted,
  meta, metricOf, pageIntro, publicNames, reportBlocks, resultFor, unitName,
} from './model.js';
import { BAR_FILL, barsSVG, breakdownData, layoutBars } from './breakdown.js';
import { highlightsSVG } from './highlights.js';
import { layoutHeatmap, heatmapSVG, rampLegendSVG } from './heatmap.js';
import { GANTT_KEY, ganttRows, layoutGantt, ganttSVG } from './gantt.js';
import { layoutSankey, sankeySVG, sankeyData, statusLegendSVG } from './sankey.js';
import { compareSeries, layoutCompare, compareSVG } from './compare.js';
import { clockModel, layoutDial, layoutMatrix, matrixSVG, dialSVG, scheduleFacts } from './clock.js';
import {
  baselineIn, imageSources, inkInset, measure, measureMetrics, rasterise, svgDocument,
  stylesheetMetrics, svgRect, svgRuns, svgText, wrapRuns,
} from './svg.js';
import { DISPLAY, FONT, GRAPHITE, INK, INK2, INK3, PAPER, RULE, TOMATO } from './theme.js';

const W = 1200;
const M = 56;

/*
 * Where the numbers in this file come from.
 *
 * Sourced from style.css via stylesheetMetrics(), so editing the stylesheet moves the image:
 *   card padding/radius/gap, card-head sizes, card-foot, KPI tile padding/radius/gap and
 *   its three type sizes, breakdown caption size/margin and the gap between bars, the
 *   whole facts row (including the inherited line-height its cells are built from),
 *   dial-cap, legend spacing.
 *
 * Still typed here, and each one a place the page and the image can drift apart:
 *   the header block (kicker 12, name 40, range 18, and the 46/32/30 advances between
 *   them), the footer (13, and its 32), and the gap after each section's chart
 *   (heatmap +14, legends +12, comparison +12, gantt +10, highlights +14, sankey +10).
 *   These have page counterparts and should be sourced; they are not, yet.
 *
 * Not CSS at all, and correctly literal: hairline offsets (the 0.5s and -1s that keep a
 * 1px stroke crisp), the dial's 300px diameter, the sankey's 360..620 height clamp, and
 * the heatmap cell size fitted to the column. The page has no rule for any of these.
 */
// .card on the page: white, hairline border, 14px corners, 20/22/18 padding, 16 below.
// The export drew every section flat on the paper, which ran them together.
const CARD_W = W - M * 2;
const CARD_BG = '#ffffff';
// Fallbacks only. The real values come from style.css via stylesheetMetrics(), so the stylesheet
// is the single source of truth for both destinations.
const FALLBACK = {
  card: { top: 20, right: 22, bottom: 18, left: 22, radius: 14, gap: 16 },
  cardHead: { size: 18, noteSize: 13, marginBottom: 16, weight: 400 },
  cardFoot: { size: 12.5, marginTop: 10 },
  kpi: { top: 13, right: 14, bottom: 11, left: 14, radius: 12, gap: 10,
         labelSize: 11.5, valueSize: 24, unitSize: 14, deltaSize: 13,
         valueWeight: 400, unitWeight: 400, deltaWeight: 400,
         lineHeight: 1.5, valueLineHeight: 1.1, valueMargin: 6, deltaMargin: 4 },
  breakdowns: { gap: 24, captionSize: 12, captionMargin: 8 },
  facts: { top: 11, right: 14, bottom: 10, left: 14, marginTop: 18, radius: 10,
           labelSize: 11, valueSize: 19, noteSize: 11.5 },
  dialCap: { size: 12.5, marginTop: 8 },
  legend: { size: 12, marginTop: 12 },
};
const SCALE = 2;
const MAX_RATIO = 1.25; // LinkedIn crops taller than 4:5 — reported, never enforced

/**
 * The report's own sentences, in the image.
 *
 * A lede under the header and a line under each heading, set the way .prose and
 * .prose-lede set them on the page: the lede a step larger, both in the second ink so
 * they read as the author talking rather than as another label on a chart. These have
 * page counterparts in style.css and are not sourced from it yet — the same debt the
 * header and the footer carry, noted above.
 */
const PROSE = {
  page: { size: 17, lineHeight: 26, gap: 22 },
  section: { size: 14.5, lineHeight: 22, gap: 16 },
};

const arrow = (d) => (d.dir > 0 ? '▲' : d.dir < 0 ? '▼' : '■');

// SECTIONS is derived from PAINT_ORDER and declared beside it, further down.
export const allSections = () => new Set(SECTIONS.map((s) => s.id));

export const TIMELINE_CHOICES = [
  { id: 'all', label: 'All projects' },
  { id: '20', label: 'Top 20' },
  { id: '10', label: 'Top 10' },
];


/** Ascent and descent for a face at a size, so spacing follows the fonts in play. */
function fontMetrics(size, weight = 400, family = undefined) {
  const m = measureMetrics(size, weight, family);
  return { ascent: Math.round(m.ascent), descent: Math.round(m.descent) };
}

/**
 * Where a card's contents start and how wide they run, and the two ways a renderer's
 * markup is set down inside the current card: place() for an <svg> at a size, at() for
 * a fragment shifted into position.
 */
function cardFrame(T) {
  const IN = M + T.card.left;
  const INNER = CARD_W - T.card.left * 2;
  return {
    IN,
    INNER,
    place: (markup, y, w, h) => markup.replace('<svg ', `<svg x="${IN}" y="${y}" width="${w}" height="${h}" `),
    at: (markup, y) => `<g transform="translate(${IN} ${y})">${markup}</g>`,
  };
}

/** The names the image may show: private repositories masked unless you chose otherwise. */
function shownNames(cur, story) {
  const names = publicNames(cur.units, story);
  const nameOf = (u) => names.get(u.key) || u.name;
  return { nameOf, maskedCount: cur.included.filter((u) => nameOf(u) !== unitName(u, story)).length };
}

/**
 * The activity calendar, its cells as large as the column allows. An 18px cap left the
 * year looking like a postage stamp in a 1200px image.
 */
function measureActivity(cur, metric, INNER) {
  const calendar = cur.series[metric].calendar;
  const offset = calendar.length ? new Date(`${calendar[0].date}T00:00:00Z`).getUTCDay() : 0;
  const cols = Math.floor((calendar.length - 1 + offset) / 7) + 1;
  const cell = Math.max(8, Math.floor((INNER - 34) / cols) - 3);
  return layoutHeatmap(calendar, { cell, gap: 3, padLeft: 34, padTop: 20 });
}

/**
 * The two project-type charts side by side, the page's desktop arrangement: the image is
 * a 1200px desktop render. Each carries its own intro, wrapped to its own column.
 */
function measureTypes(cur, story, { T, IN, INNER }) {
  const barsGap = T.breakdowns.gap;
  const barsW = Math.floor((INNER - barsGap) / 2);
  const bars = [
    { id: 'language', title: 'Lines of code by language', data: breakdownData(cur.included, story, 'language', 'lines') },
    { id: 'category', title: 'Projects by category', data: breakdownData(cur.included, story, 'category', 'lines') },
  ].map((b, i) => ({
    ...b,
    x: IN + i * (barsW + barsGap),
    L: layoutBars(b.data, { width: barsW, noun: b.data.noun, fill: BAR_FILL }),
    prose: wrapRuns(introFor(story, `types:${b.id}`), { size: PROSE.section.size, room: barsW }),
  }));
  return { bars, barsW, barsGap };
}

/** The starred projects, with their screenshots as data URIs: detached markup fetches nothing. */
async function measureHighlights(cur, story) {
  const hlUnits = cur.included.filter((u) => isHighlighted(u, story));
  const sources = await imageSources(hlUnits.map((u) => meta(story, u.key).image), { inline: true });
  return { hlUnits, sources };
}

/** The hour dial and the weekday grid that sits beside it. */
function measureHours(cur, metric, INNER) {
  const clock = clockModel(cur, metric);
  return { clock, dial: layoutDial(clock, { size: 300, pad: 44 }), matrix: layoutMatrix(clock, { W: INNER - 330 }) };
}

/**
 * The timeline, cut to the rows you chose. The height warning is advisory: nothing here
 * shrinks a chart to chase a ratio, and the timeline choice is the only thing that
 * changes the report, because you made it.
 */
function measureProjects(cur, metric, timeline, INNER) {
  const ganttTotal = ganttRows(cur.included, Infinity, metric).length;
  const rows = timeline === 'all' ? ganttTotal : Math.min(ganttTotal, Number(timeline));
  const gantt = layoutGantt(cur.period, ganttRows(cur.included, rows, metric),
    { W: INNER, rowH: 26, barH: 12, labelW: 190, resultW: 150, countW: 78, headH: 26, metric });
  return { gantt, ganttTotal };
}

/** The sankey, as tall as its project column needs within 360..620. */
function measureEffort(cur, story, nameOf, metric, INNER) {
  const sd = sankeyData(cur, story, { maxProjects: 12, nameOf, metric });
  const projectNodes = sd.nodes.filter((n) => n.col === 1).length;
  const H = Math.max(360, Math.min(620, 150 + 30 * projectNodes));
  return { sd, sk: layoutSankey(sd, { W: INNER, H, padR: 220, padL: 80, gap: 14 }) };
}

/**
 * Every prose slot, wrapped, so the paint only places lines it was handed. A card whose
 * charts carry their own prose has no slot of its own: the same test the page applies,
 * so the two cannot disagree about which slots exist.
 */
function measureProse(story, INNER) {
  const prose = { page: wrapRuns(pageIntro(story), { size: PROSE.page.size, room: CARD_W }) };
  for (const id of SECTION_ORDER) {
    prose[id] = PROMPTS[id] ? wrapRuns(introFor(story, id), { size: PROSE.section.size, room: INNER }) : [];
  }
  return prose;
}

/**
 * Everything the paint needs, measured once: the card frame, the names it may show, a
 * layout for every section, and the prose wrapped to its columns.
 *
 * Measuring and painting were one body of three hundred lines, which is what made it
 * unreadable: the paint reaches for dozens of measurements and nothing said where they
 * came from. The seam is named now. This half decides how big everything is, using the
 * same layout functions the page uses, one small function per section. The half below
 * decides only where it sits. Nothing here emits a mark; nothing there measures one.
 */
async function measurePage(model, story, sections, timeline, metric) {
  const T = (await stylesheetMetrics()) || FALLBACK;
  const frame = cardFrame(T);
  const cur = model.current;
  const { nameOf, maskedCount } = shownNames(cur, story);
  const cmp = model.previous.length
    ? layoutCompare(compareSeries(model, metric), { W: frame.INNER, H: 200, padR: 170 })
    : null;
  return {
    T, ...frame, model, story, metric, on: sections,
    cur, prev: model.previous[0], nameOf, resOf: (u) => resultFor(u, story), maskedCount,
    noun: metricOf(metric).noun, fontMetrics,
    heat: measureActivity(cur, metric, frame.INNER),
    ...measureTypes(cur, story, { T, ...frame }),
    ...(await measureHighlights(cur, story)),
    ...measureHours(cur, metric, frame.INNER),
    cmp,
    ...measureProjects(cur, metric, timeline, frame.INNER),
    ...measureEffort(cur, story, nameOf, metric, frame.INNER),
    prose: measureProse(story, frame.INNER),
  };
}

/**
 * The paint in progress: the marks so far, the cursor every section advances, and the
 * card currently being filled.
 *
 * A card's height isn't known until its body is emitted, so opening one reserves a slot
 * in the mark list and closing it backfills the rect behind everything drawn since.
 * That reservation is the only reason this needs to be an object rather than a list of
 * calls — and the reason every section has to go through it rather than pushing marks
 * of its own.
 *
 * Two things the caller owes it, because nothing here can see the end of the page:
 * closeCard() after the last section, or the last card's background is never drawn;
 * and `slot` set to the section's id before its section() call, which is how section()
 * finds that section's intro. paintPage does both — it is the only caller.
 */
function painter(ctx) {
  const { T, IN, INNER } = ctx;
  const out = [];
  // Matches .card-head on the page: an 18px title with a muted note beside it.
  // .card-head h2 tracks at -0.01em; measure() knows nothing about letter-spacing, so
  // the note's offset carries the same correction the glyphs do.
  const TRACK = -0.01 * T.cardHead.size;   // .card-head h2 { letter-spacing: -0.01em }
  const FOOT = T.cardFoot;
  let card = null;

  const p = {
    y: M + 10,
    // The section currently being painted, set by paintPage so section() can find that
    // section's intro without every painter having to pass along an id it never uses.
    slot: null,
    push: (markup) => out.push(markup),
    text: (str, px, py, o) => out.push(svgText(str, px, py, o)),
    rule: (py) => out.push(svgRect(M, Math.round(py) + 0.5, CARD_W, 1, { fill: RULE })),
    at: (markup, y) => out.push(ctx.at(markup, y)),
    place: (markup, y, w, h) => out.push(ctx.place(markup, y, w, h)),
    body: () => out.join(''),

    /**
     * A run of wrapped lines, left at `x`, with the gap after it that its own style
     * carries. Nothing is emitted for an empty slot, and p.y does not move — which is
     * what makes a report with no prose identical to the one before any of this.
     */
    prose: (lines, { x: px, style }) => {
      if (!lines?.length) return;
      // Same line box the page gives it, so a two-line intro occupies the same space in
      // both destinations: the baseline sits where CSS would put it.
      const base = baselineIn(style.lineHeight, style.size);
      for (const line of lines) {
        if (line.length) out.push(svgRuns(line, px, p.y + base, { size: style.size, fill: INK2 }));
        p.y += style.lineHeight;
      }
      p.y += style.gap;
    },

    closeCard: () => {
      if (!card) return;
      // .card-foot: the page prints a note under the body; the exporter used to drop it
      // entirely, because section() had no notion of one.
      if (card.foot) {
        p.y += FOOT.marginTop + 10;
        p.text(card.foot, IN, p.y, { size: FOOT.size, fill: INK3 });
      }
      out[card.slot] = svgRect(M + 0.5, card.top + 0.5, CARD_W - 1, (p.y + T.card.bottom) - card.top - 1,
        { fill: CARD_BG, r: T.card.radius, stroke: RULE, sw: 1 });
      p.y += T.card.bottom + T.card.gap;
      card = null;
    },

    section: (title, right, foot = '', headLegend = '') => {
      p.closeCard();
      card = { top: p.y, slot: out.length, foot };
      out.push('');
      p.text(title, IN, p.y + T.card.top + 14, { size: T.cardHead.size, weight: T.cardHead.weight, fill: INK, tracking: TRACK });
      const w = measure(title, T.cardHead.weight, T.cardHead.size) + title.length * TRACK;
      if (right) p.text(right, IN + w + 14, p.y + T.card.top + 14, { size: T.cardHead.noteSize, fill: INK3 });
      // The page pushes a chart key to the right edge of the card head with
      // margin-left:auto; an end anchor at the card's inner edge is the same thing.
      if (headLegend) {
        p.text(headLegend, IN + INNER, p.y + T.card.top + 14,
          { size: T.cardHead.noteSize, fill: INK3, anchor: 'end' });
      }
      p.y += T.card.top + Math.round(T.cardHead.size * 1.2) + T.cardHead.marginBottom;
      // The section's own line, between its heading and its chart — the same place it
      // sits on the page.
      p.prose(ctx.prose[p.slot], { x: IN, style: PROSE.section });
    },
  };
  return p;
}

/** Whose report this is, and what it covers. Drawn on the paper, not on a card. */
function paintHeader(p, ctx) {
  const { cur, prev, fontMetrics, model } = ctx;
  // Bigger than the body copy by a wide margin, and deliberately short of the column:
  // fitting the title to the full 1088px sets it around 106px, which stops reading as a
  // title and starts reading as a banner. 64 is the same ceiling the page's h1 grows to,
  // so the image and the site agree.
  const TITLE_SIZE = 64;
  const DATE_SIZE = 18;
  const titleTop = fontMetrics(TITLE_SIZE, 400, DISPLAY);
  const dateTop = fontMetrics(DATE_SIZE, 400);
  // The handle steps back a tone instead of lighting up — it says whose report this is,
  // which is not the headline of it. Tomato is spent on what is live, not on a name.
  const lead = 'Report Card: ';
  // The title hangs by its own side bearing, so its ink lands on the margin the cards
  // and the paragraphs line up on instead of a few pixels inside it. Both runs move
  // together — the handle is positioned off the lead's width, not off the margin.
  const x0 = M - inkInset(lead.trim(), { size: TITLE_SIZE, family: DISPLAY });
  p.text(lead.trim(), x0, p.y + titleTop.ascent, { size: TITLE_SIZE, weight: 400, family: DISPLAY, fill: INK });
  p.text(`@${model.viewer.login}`, x0 + measure(lead, 400, TITLE_SIZE, DISPLAY), p.y + titleTop.ascent,
    { size: TITLE_SIZE, weight: 400, family: DISPLAY, fill: INK2 });
  // Line boxes must not overlap: the title's descent plus the date's ascent is the
  // floor, and 10px on top of that is the breathing room.
  p.y += titleTop.ascent + titleTop.descent + 10 + dateTop.ascent;
  // The current period reads first. The comparison follows a step smaller and a shade
  // lighter so the two ranges stop claiming equal weight. Its gap lives in the offset,
  // not in a leading space -- SVG collapses those, which is what glued "30,071(1%)".
  const curRange = fmtRange(cur.period.from, cur.period.to);
  p.text(curRange, M, p.y, { size: DATE_SIZE, fill: INK2 });
  if (prev) {
    p.text(`· vs ${fmtRange(prev.period.from, prev.period.to)}`,
      M + measure(curRange, 400, DATE_SIZE) + measure('  ', 400, DATE_SIZE), p.y,
      { size: DATE_SIZE - 2, fill: INK3 });
  }
  p.y += 30;
}

/**
 * The KPI row: 7 tiles across, each its own bordered surface.
 *
 * The vertical rhythm is derived the way the browser derives it — three stacked blocks,
 * each a line box tall, separated by their margins, inside the padding and the 1px
 * border. Change a font-size or a margin in style.css and both destinations move
 * together; these used to be the literals 26/60/82 and 97/76.
 */
function paintKpis(p, ctx) {
  const { T, cur, prev } = ctx;
  const gap = T.kpi.gap;
  const colW = (CARD_W - gap * (KPIS.length - 1)) / KPIS.length;
  const labelLB = T.kpi.labelSize * T.kpi.lineHeight;
  const valueLB = T.kpi.valueSize * T.kpi.valueLineHeight;
  const deltaLB = T.kpi.deltaSize * T.kpi.lineHeight;
  const contentTop = 1 + T.kpi.top;
  const valueTop = contentTop + labelLB + T.kpi.valueMargin;
  const deltaTop = valueTop + valueLB + T.kpi.deltaMargin;
  const labelBase = contentTop + baselineIn(labelLB, T.kpi.labelSize);
  const valueBase = valueTop + baselineIn(valueLB, T.kpi.valueSize, T.kpi.valueWeight);
  const deltaBase = deltaTop + baselineIn(deltaLB, T.kpi.deltaSize, T.kpi.deltaWeight);
  // Only the comparison adds a foot line now, so without it every tile is two lines.
  const tileH = (prev ? deltaTop + deltaLB : valueTop + valueLB) + T.kpi.bottom + 1;
  KPIS.forEach((k, i) => {
    const tx = M + i * (colW + gap);
    p.push(svgRect(tx + 0.5, p.y + 0.5, colW - 1, tileH - 1,
      { fill: CARD_BG, r: T.kpi.radius, stroke: RULE, sw: 1 }));
    p.text(k.label.toUpperCase(), tx + T.kpi.left, p.y + labelBase,
      { size: T.kpi.labelSize, fill: INK3, tracking: 0.06 * T.kpi.labelSize });
    const value = fmtBig(cur.totals[k.key]);
    p.text(value, tx + T.kpi.left, p.y + valueBase,
      { size: T.kpi.valueSize, weight: T.kpi.valueWeight, fill: INK, tracking: -0.03 * T.kpi.valueSize });
    if (k.unit) {
      p.text(k.unit, tx + T.kpi.left + measure(value, T.kpi.valueWeight, T.kpi.valueSize)
        - value.length * 0.03 * T.kpi.valueSize + 5, p.y + valueBase,
        { size: T.kpi.unitSize, weight: T.kpi.unitWeight, fill: INK3 });
    }
    // Mirrors dashboard.js: a delta when there's a previous period, otherwise the
    // "of N days" note that only Active Days carries.
    if (prev) {
      const d = delta(cur.totals[k.key], prev.totals[k.key]);
      const lead = `${arrow(d)} ${d.text} `;
      p.text(lead, tx + T.kpi.left, p.y + deltaBase, { size: T.kpi.deltaSize, weight: T.kpi.deltaWeight, fill: INK2 });
      p.text(`vs ${fmtTight(prev.totals[k.key])}`, tx + T.kpi.left + measure(lead, T.kpi.deltaWeight, T.kpi.deltaSize),
        p.y + deltaBase, { size: T.kpi.deltaSize, fill: INK3 });
    }
  });
  p.y += tileH + T.card.gap;
}

/** The year as a calendar, and the ramp that says what a shade is worth. */
function paintActivity(p, ctx) {
  const { T, heat, noun } = ctx;
  p.section('Activity');
  p.at(heatmapSVG(heat, { size: 11 }), p.y);
  p.y += heat.height + 14;
  const legend = rampLegendSVG(heat.cuts, noun, { fmt: fmtNum });
  p.at(legend.markup, p.y);
  p.y += legend.height + T.legend.marginTop;
}

/** The two bar charts, side by side, each under its own caption and total. */
function paintTypes(p, ctx) {
  const { T, bars, barsW } = ctx;
  p.section('Project types');
  // Measured off .breakdown figcaption: an 18px line box whose baseline sits 12px
  // down, plus margin-bottom 8 -- so the bar starts 26px below the caption's TOP.
  // text() places a baseline and the page measures box edges; comparing those two
  // directly is what kept the page and the export out of step.
  // figcaption's line box is ~1.5x its font-size; the baseline sits a descender
  // above the box bottom, and margin-bottom follows. All three come from the CSS.
  const CAP_LINE = Math.round(T.breakdowns.captionSize * 1.5);
  const CAP_BASELINE = Math.round(CAP_LINE * 0.67);
  const CAP_TO_BAR = CAP_LINE + T.breakdowns.captionMargin;
  // Two columns painted at one cursor: the card is as tall as the longer of them, and
  // the shorter one simply ends sooner, which is what the page's grid does too.
  // Each column flows from its own caption and its own line of prose, which is what the
  // page's grid does. Levelling the two charts instead was tempting and wrong: they are
  // separate rankings on separate scales, so there is nothing to read across, and the
  // page and the image would have disagreed about where a chart starts.
  const proseH = (lines) => (lines.length ? lines.length * PROSE.section.lineHeight + PROSE.section.gap : 0);
  const base = baselineIn(PROSE.section.lineHeight, PROSE.section.size);
  const top = p.y;
  for (const bar of bars) {
    p.text(bar.title.toUpperCase(), bar.x, top + CAP_BASELINE,
      { size: T.breakdowns.captionSize, fill: INK3, tracking: 0.06 * T.breakdowns.captionSize });
    if (bar.prose.length) {
      const lines = bar.prose
        .map((line, i) => (line.length
          ? svgRuns(line, 0, i * PROSE.section.lineHeight + base, { size: PROSE.section.size, fill: INK2 })
          : ''))
        .join('');
      p.push(`<g transform="translate(${bar.x} ${top + CAP_TO_BAR})">${lines}</g>`);
    }
    const chartY = top + CAP_TO_BAR + proseH(bar.prose);
    p.push(`<g transform="translate(${bar.x} ${chartY})">${barsSVG(bar.L, { interactive: false })}</g>`);
  }
  p.y = top + CAP_TO_BAR + Math.max(...bars.map((b) => proseH(b.prose) + b.L.height));
}

/** The dial, the weekday grid beside it, and the schedule read off them. */
function paintHours(p, ctx) {
  const { T, IN, INNER, clock, dial, matrix } = ctx;
  p.section('Working hours');
  p.place(dialSVG(dial, clock), p.y, dial.size, dial.size);
  // .dial-cap: names the two arcs. Without it the dial shows a thin and a thick
  // stroke with nothing saying what they mean.
  const capY = p.y + dial.size + T.dialCap.marginTop + 10;
  const keyParts = [['thin', 'Working window'], ['thick', 'Busiest']];
  let kx = IN + 10;
  for (const [kind, label] of keyParts) {
    const lw = 15;
    p.push(svgRect(kx, capY - 4, lw, kind === 'thick' ? 3.5 : 1.5,
      { fill: kind === 'thick' ? TOMATO : GRAPHITE[2] }));
    p.text(label, kx + lw + 6, capY, { size: T.dialCap.size, fill: INK3 });
    kx += lw + 6 + measure(label, 400, T.dialCap.size) + 16;
  }
  // .clock-grid centres its items (align-items: center), so the matrix sits halfway
  // down the dial rather than pinned to its top -- otherwise the card carries a dead
  // band under the matrix as tall as the difference between them.
  const matrixY = p.y + Math.max(0, Math.round((dial.size - matrix.H) / 2));
  const placedMatrix = ctx.place(matrixSVG(matrix, clock), matrixY, matrix.W, matrix.H);
  // Offset the matrix beside the dial. A .replace() that matches nothing fails
  // silently, so the shift is asserted rather than assumed.
  const shifted = placedMatrix.replace(`x="${IN}"`, `x="${IN + dial.size + 30}"`);
  if (shifted === placedMatrix) throw new Error('matrix offset did not apply');
  p.push(shifted);
  p.y += Math.max(dial.size, matrix.H) + 16;

  const facts = scheduleFacts(clock);
  // .facts is a bordered, rounded container whose 1px grid gap shows through as
  // dividers between cells. The exporter drew bare text on the card instead.
  p.y += T.facts.marginTop;
  const factW = INNER / facts.length;
  // Each child is a block, so its line box -- not its font size -- takes the
  // space, and line-height is inherited from body so no .fact rule mentions it.
  const lh = T.facts.lineHeight;
  const labelBox = T.facts.labelSize * lh;
  const valueBox = T.facts.valueSize * lh;
  const noteBox = T.facts.noteSize * lh;
  const labelY = T.facts.top + baselineIn(labelBox, T.facts.labelSize, 400);
  const valueY =
    T.facts.top + labelBox + T.facts.valueGap
    + baselineIn(valueBox, T.facts.valueSize, T.facts.valueWeight);
  const noteY = T.facts.top + labelBox + T.facts.valueGap + valueBox
    + baselineIn(noteBox, T.facts.noteSize, 400);
  const factH = Math.round(
    T.facts.top + labelBox + T.facts.valueGap + valueBox + noteBox + T.facts.bottom,
  );
  p.push(svgRect(IN + 0.5, p.y + 0.5, INNER - 1, factH - 1,
    { fill: CARD_BG, r: T.facts.radius, stroke: RULE, sw: 1 }));
  facts.forEach((f, i) => {
    const fx = IN + i * factW;
    if (i) p.push(svgRect(fx, p.y + 1, 1, factH - 2, { fill: RULE }));
    const tx = fx + T.facts.left;
    p.text(f.label.toUpperCase(), tx, p.y + labelY,
      { size: T.facts.labelSize, fill: INK3, tracking: 0.06 * T.facts.labelSize });
    p.text(f.value, tx, p.y + valueY,
      { size: T.facts.valueSize, weight: T.facts.valueWeight, fill: INK, tracking: -0.02 * T.facts.valueSize });
    p.text(f.note, tx, p.y + noteY, { size: T.facts.noteSize, fill: INK3 });
  });
  p.y += factH;
}

/** This period against the ones before it, on one day-of-period axis. */
function paintCompare(p, ctx) {
  const { INNER, cmp, noun } = ctx;
  p.section('Compared with earlier periods', '', '', `Cumulative ${noun}, aligned by day of period; month labels are this period’s`);
  p.place(compareSVG(cmp), p.y, INNER, cmp.H);
  p.y += cmp.H + 12;
}

/** Every project as a bar, ordered by when it began. */
function paintProjects(p, ctx) {
  const { T, INNER, gantt, ganttTotal, noun, nameOf, resOf } = ctx;
  const trimmed = gantt.rows.length < ganttTotal ? `top ${gantt.rows.length} of ${ganttTotal} by ${noun}` : '';
  p.section('Projects over time', trimmed);
  p.place(ganttSVG(gantt, { nameOf, resultOf: resOf }), p.y, INNER, gantt.H);
  p.y += gantt.H + 10;
  const legend = rampLegendSVG(gantt.cuts, noun,
    { zero: null, unit: 'in a week', fmt: fmtNum, tail: GANTT_KEY });
  p.at(legend.markup, p.y);
  p.y += legend.height + T.legend.marginTop;
}

/** The projects you starred, with their screenshots carried in as data URIs. */
function paintHighlights(p, ctx) {
  const { INNER, hlUnits, sources, story } = ctx;
  p.section('Project highlights', '', '', `${hlUnits.length} chosen`);
  const hl = highlightsSVG(hlUnits, story, { width: INNER, sources });
  p.at(hl.markup, p.y);
  p.y += hl.height + 14;
}

/** Quarter → project → outcome → why. */
function paintEffort(p, ctx) {
  const { T, INNER, sk } = ctx;
  p.section('Where the effort went');
  p.place(sankeySVG(sk), p.y, INNER, sk.H);
  p.y += sk.H + 10;
  const legend = statusLegendSVG(sk, { size: T.legend.size });
  p.at(legend.markup, p.y);
  p.y += legend.height + T.legend.marginTop;
}

/**
 * A footer only when it has something to say. The github.com line repeated what the
 * title already states, and the rule above it existed to fence off that repetition.
 * The masked note stays: a reader has to know those names were withheld rather than
 * invented. It is set in the sans now -- with the URL gone it would otherwise be the
 * only monospaced line in the document.
 */
function paintMaskedNote(p, ctx) {
  p.rule(p.y);
  p.y += 32;
  p.push(svgText(`${ctx.maskedCount} private project${ctx.maskedCount === 1 ? '' : 's'} shown without names`,
    M, p.y, { size: 13, fill: INK3 }));
}

/**
 * The report, in the order it argues.
 *
 * Data first: the whole year of projects, then the few worth stopping on, then when
 * you worked, then what kind of work it was and how it turned out. Highlights sit
 * second rather than first — opening on three hand-picked cards reads as a brag
 * before the reader has any measure of the year to judge them against, and the
 * timeline gives them that. What was built comes before when it was built, because a
 * year of days is only worth reading once you know what filled them; the calendar and
 * the working hours then sit together, since they are one question at two grains and
 * reading them apart means learning the same shape twice. The comparison closes, and
 * is last because it is the one section that may not be there at all — an optional
 * card mid-report changes the shape of every report that omits it.
 *
 * `when` is what makes a section worth drawing: a highlights card with nothing starred
 * is an empty box, not a section.
 *
 * The order below is only this list's own reading order — the report's order lives in
 * the story's block list, which both paintPage and the page walk. That is what finally
 * closed the duplication that once had Working hours third in the image and sixth on
 * the page; the two are declared together in SECTION_ORDER now.
 */
const PAINT_ORDER = [
  { id: 'projects', label: 'Projects over time', paint: paintProjects, when: () => true },
  { id: 'highlights', label: 'Project highlights', paint: paintHighlights, when: (c) => c.hlUnits.length },
  { id: 'activity', label: 'Activity', paint: paintActivity, when: () => true },
  { id: 'hours', label: 'Working hours', paint: paintHours, when: (c) => c.clock.total },
  { id: 'types', label: 'Project types', paint: paintTypes, when: () => true },
  { id: 'effort', label: 'Where the effort went', paint: paintEffort, when: (c) => c.sk.ribbons.length },
  { id: 'compare', label: 'Comparison', paint: paintCompare, when: (c) => c.cmp },
];

/**
 * The export picker's rows: the same list the paint walks, minus the painters, so the
 * checkboxes read down the image in the order the image draws them.
 */
export const SECTIONS = PAINT_ORDER.map(({ id, label }) => ({ id, label }));

/**
 * One pass down the page, header and totals first and then every chosen section in
 * turn. The painter carries the cursor: a section draws at `p.y` and leaves it below
 * whatever it drew, so this only decides what runs and in what order.
 */
function paintPage(ctx, { lede = true } = {}) {
  const p = painter(ctx);
  paintHeader(p, ctx);
  // The lede sits between the date range and the totals, at the paper's own margin
  // rather than a card's: it is the page talking, not a section.
  if (lede) p.prose(ctx.prose.page, { x: M, style: PROSE.page });
  paintKpis(p, ctx);
  // Order comes from the report, not from this file: reportBlocks walks the stored
  // block list, and PAINT_ORDER is only the registry of who draws what.
  const painters = new Map(PAINT_ORDER.map((s) => [s.id, s]));
  const present = new Set(PAINT_ORDER.filter((s) => s.when(ctx)).map((s) => s.id));
  for (const { chart } of reportBlocks(ctx.story, present)) {
    if (!ctx.on.has(chart)) continue;
    p.slot = chart;
    painters.get(chart).paint(p, ctx);
  }
  p.slot = null;
  p.closeCard();
  if (ctx.maskedCount) paintMaskedNote(p, ctx);

  return { body: p.body(), height: p.y + M - 18, rows: ctx.gantt.rows.length };
}

/**
 * Build the export as an SVG document. Separated from rasterising so the markup can be
 * compared with the page directly — text against text — instead of being eyeballed.
 */
export async function buildSvg(model, story, sections = allSections(), timeline = 'all', metric = 'commits', { lede = true } = {}) {
  const ctx = await measurePage(model, story, sections, timeline, metric);
  const page = paintPage(ctx, { lede });
  const height = Math.ceil(page.height);
  const svg = svgDocument({ width: W, height, background: PAPER, body: page.body });
  return { svg, width: W, height, rows: page.rows, totalRows: ctx.ganttTotal, fits: height / W <= MAX_RATIO };
}

/**
 * The share image: the report at the 1200x630 an unfurler wants.
 *
 * Not a second rendering — it is the export, drawn at 1:1 and cut off at 630px, so the
 * header, the totals and the activity heatmap are exactly the ones in the image people
 * download. The lede is left out: a paragraph of text is what a link preview already
 * has in its description, and the card is the one place the year can be shown instead
 * of described. Whatever is below the cut is simply not drawn.
 */
export const SHARE = { width: W, height: 630 };

export async function renderShare(model, story, canvas, metric = 'commits') {
  const built = await buildSvg(model, story, new Set(['activity']), 'all', metric, { lede: false });
  await rasterise(built.svg, canvas, {
    width: built.width, height: built.height, scale: 1, cropHeight: SHARE.height,
  });
  return SHARE;
}

/** Rasterise that document into `canvas`. */
export async function renderPng(model, story, canvas, sections = allSections(), timeline = 'all', metric = 'commits') {
  const built = await buildSvg(model, story, sections, timeline, metric);
  await rasterise(built.svg, canvas, { width: built.width, height: built.height, scale: SCALE });
  return built;
}
