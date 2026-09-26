/**
 * Does the exported image say the same thing, the same way, as the page?
 *
 * Both destinations share every renderer, but they still disagree wherever the page
 * styles text with CSS and the export writes attributes — a section title that is 18px
 * bold on screen and a small grey caption in the PNG. Noticing that has been a person's
 * job, which makes it a job that only gets done when someone is already annoyed. This
 * reads both sides, normalises them to the same shape, and prints what differs.
 */
import { buildSvg } from './export.js';

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const key = (s) => norm(s).toLowerCase();
const px = (v) => Math.round(parseFloat(v) * 10) / 10;

/** First family in a stack, unquoted and lowercased — the rest are only fallbacks. */
const firstFamily = (stack) => String(stack || '').split(',')[0].trim()
  .replace(/^['\"]|['\"]$/g, '').toLowerCase();
const DEFAULT_FAMILY = 'LINE Seed JP';

/** Computed styles arrive as rgb(); SVG carries hex. Compare them in one form. */
const toHex = (c) => {
  const m = /^rgba?\(([^)]+)\)$/.exec(String(c).trim());
  if (!m) return String(c).trim().toLowerCase();
  const [r, g, b] = m[1].split(',').map((n) => Math.round(parseFloat(n)));
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
};

/** The page's own typography, as rendered. */
export function fromPage(root = document) {
  const out = [];
  const take = (el, role, styleFrom = null) => {
    if (!el) return;
    const text = norm(el.textContent);
    if (!text) return;
    const cs = getComputedStyle(styleFrom || (el.nodeType === 3 ? el.parentElement : el));
    out.push({
      role, text, size: px(cs.fontSize), weight: Number(cs.fontWeight),
      fill: toHex(cs.color), tracking: px(cs.letterSpacing === 'normal' ? 0 : cs.letterSpacing),
      family: firstFamily(cs.fontFamily),
    });
  };
  for (const el of root.querySelectorAll('.card-head h2')) take(el, 'section title');
  // The report's own sentences: the one text the export sizes from its own constants
  // rather than from stylesheetMetrics(), so this is where that drift would show up.
  for (const el of root.querySelectorAll('.prose-lede p')) take(el, 'page intro');
  for (const el of root.querySelectorAll('.prose:not(.prose-lede) p')) take(el, 'section intro');
  for (const el of root.querySelectorAll('.card-head .muted')) take(el, 'section note');
  for (const el of root.querySelectorAll('.breakdown figcaption')) take(el, 'chart caption');
  for (const el of root.querySelectorAll('.kpi-label')) take(el, 'kpi label');
  for (const el of root.querySelectorAll('.kpi-value')) {
    // <b>68<small>days</small></b> -- the number and its unit are drawn as two separate
    // <text> elements in the export, so they have to be compared as two entries.
    take(el.firstChild, 'kpi value', el);
    const unit = el.querySelector('small');
    if (unit) take(unit, 'kpi unit');
  }
  return out;
}

/** The export's typography, read back out of the markup it will actually rasterise. */
export function fromSvg(markup) {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const bad = doc.querySelector('parsererror');
  if (bad) throw new Error(`export SVG did not parse: ${norm(bad.textContent).slice(0, 200)}`);
  return [...doc.querySelectorAll('text')].map((t) => ({
    text: norm(t.textContent),
    size: px(t.getAttribute('font-size')),
    weight: Number(t.getAttribute('font-weight') || 400),
    fill: String(t.getAttribute('fill') || '').toLowerCase(),
    tracking: px(t.getAttribute('letter-spacing') || 0),
    // No font-family attribute means it inherits the document default, which is
    // the body face — what the page reports for un-styled text.
    family: firstFamily(t.getAttribute('font-family') || DEFAULT_FAMILY),
  })).filter((t) => t.text);
}

/**
 * Match page text to export text by the string itself — the one thing both sides agree
 * on — and report every typographic difference. Uppercasing is a CSS transform on the
 * page and a literal string in the export, so keys are compared case-insensitively.
 */
export async function auditTypography(model, story, opts = {}) {
  const built = await buildSvg(model, story, opts.sections, opts.timeline ?? 'all', opts.metric ?? 'commits');
  const shot = fromSvg(built.svg);
  const byKey = new Map();
  for (const t of shot) if (!byKey.has(key(t.text))) byKey.set(key(t.text), t);

  /**
   * A paragraph is one element on the page and one <text> per wrapped line in the
   * export, so its whole string never matches. Its first line is a prefix of it, and
   * that line carries the same size, weight and colour as the rest — which is what is
   * being compared. Short prefixes are ignored: "Rust" prefixes half the report.
   */
  const prefixMatch = (text) => {
    const k = key(text);
    let best = null;
    for (const [candidate, entry] of byKey) {
      if (candidate.length < 16 || !k.startsWith(candidate)) continue;
      if (!best || candidate.length > key(best.text).length) best = entry;
    }
    return best;
  };

  const rows = [];
  for (const p of fromPage()) {
    const e = byKey.get(key(p.text)) || prefixMatch(p.text);
    if (!e) {
      rows.push({ role: p.role, text: p.text, problem: 'missing from export' });
      continue;
    }
    const diffs = [];
    if (p.size !== e.size) diffs.push(`size ${p.size} → ${e.size}`);
    if (p.weight !== e.weight) diffs.push(`weight ${p.weight} → ${e.weight}`);
    if (p.fill !== e.fill) diffs.push(`colour ${p.fill} → ${e.fill}`);
    if (p.tracking !== e.tracking) diffs.push(`tracking ${p.tracking} → ${e.tracking}`);
    if (p.family !== e.family) diffs.push(`font ${p.family} → ${e.family}`);
    if (diffs.length) rows.push({ role: p.role, text: p.text, problem: diffs.join(', ') });
  }
  return { rows, ok: rows.length === 0, pageTexts: fromPage().length, exportTexts: shot.length, built };
}

/**
 * EXHAUSTIVE text comparison: every string the page renders must appear in the export.
 *
 * The earlier version compared only the categories I had thought to list -- titles,
 * notes, captions, KPIs -- so three entirely missing elements (a card foot, a dial arc
 * key, a facts row) still reported a clean pass. Anything absent from the chosen list was
 * invisible to it. This walks every text node under .dash instead, so a new element on
 * the page is a failure here until the export draws it too.
 */
export function everyPageString(root = document) {
  const host = root.querySelector('.dash') || root.body || root;
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!norm(node.textContent)) return NodeFilter.FILTER_REJECT;
      const el = node.parentElement;
      // <title> is a hover tooltip. The export is a still image with no pointer, so its
      // absence is correct, not a gap.
      if (el.closest('title, desc')) return NodeFilter.FILTER_REJECT;
      // Page chrome: controls and the wizard header are not part of the report.
      if (el.closest('button, select, .seg, .modal, .steps, .actions, .eyebrow, [aria-hidden="true"]')) {
        return NodeFilter.FILTER_REJECT;
      }
      // The editing view: a prompt nobody answered, an offered draft, a character
      // count. Only the owner ever sees these, and the export is not for the owner.
      if (el.closest('.prose-draft, .prose-count, textarea')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const out = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    out.push({
      text: norm(n.textContent),
      where: el.tagName.toLowerCase() + (el.className ? `.${String(el.className).split(' ')[0]}` : ''),
      size: px(cs.fontSize), weight: Number(cs.fontWeight), fill: toHex(cs.color),
    });
  }
  return out;
}

/** Which of the page's strings the export never draws. */
export async function missingFromExport(svg, root = document) {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const inExport = new Set();
  for (const t of doc.querySelectorAll('text')) {
    const whole = norm(t.textContent);
    if (!whole) continue;
    inExport.add(key(whole));
    // The page often splits a label from its value; index the pieces as well as the whole.
    for (const part of t.querySelectorAll('tspan')) {
      const piece = norm(part.textContent);
      if (piece) inExport.add(key(piece));
    }
    for (const piece of whole.split(/\s{2,}|\u00a0/)) if (norm(piece)) inExport.add(key(norm(piece)));
  }
  // The export writes some strings uppercased that CSS only displays uppercased.
  const seen = new Set();
  const gaps = [];
  // One continuous string of everything the export draws, so a page line that the export
  // wrapped differently still matches by containment.
  const haystack = key([...doc.querySelectorAll('text')].map((t) => norm(t.textContent)).join(' '));
  for (const p of everyPageString(root)) {
    const k = key(p.text);
    if (inExport.has(k) || seen.has(k) || haystack.includes(k)) continue;
    seen.add(k);
    gaps.push(p);
  }
  return gaps;
}

/**
 * Vertical rhythm, which typography alone never catches: the bars share a renderer with
 * the page, but the space around them came from CSS on one side and hand-written `y`
 * increments on the other, so they drifted apart without a single glyph changing.
 *
 * Measures the page's real gaps from laid-out boxes and compares them to the export's,
 * read back out of the SVG geometry.
 */
export function spacingOnPage(root = document) {
  const gaps = [];
  // The two charts sit side by side, so there is no gap between them to compare — the
  // span both destinations describe the same way is the caption's box top down to the
  // chart that follows it.
  [...root.querySelectorAll('.breakdown')].forEach((fig, i) => {
    const cap = fig.querySelector('figcaption');
    // Whatever the caption is followed by: the chart, or the chart's own line of prose.
    // Not the chart itself — prose wraps to the column it is in, and the image's columns
    // are not the page's, so any span that contains prose differs by design.
    const next = fig.querySelector('.prose') || fig.querySelector('.bars-host svg');
    if (!cap || !next) return;
    gaps.push({
      name: `caption -> body (${i + 1})`,
      px: Math.round(next.getBoundingClientRect().top - cap.getBoundingClientRect().top),
    });
    const host = fig.querySelector('.bars-host svg');
    if (host) gaps.push({ name: `chart ${i + 1} height`, px: Math.round(host.getBoundingClientRect().height), info: true });
  });
  return gaps;
}

/**
 * The working-hours facts row: cell height, and where each of the three lines sits
 * inside a cell. These are block boxes whose line-height is inherited, so the geometry
 * cannot be computed from the declared font sizes -- it has to be measured.
 */
export function factsOnPage(root = document) {
  const cell = root.querySelector('.fact');
  if (!cell) return null;
  const box = cell.getBoundingClientRect();
  const at = (sel) => {
    const el = cell.querySelector(sel);
    if (!el) return null;
    const r = document.createRange();
    r.selectNodeContents(el);
    const t = r.getBoundingClientRect();
    return { top: Math.round(t.top - box.top), bottom: Math.round(t.bottom - box.top) };
  };
  return {
    height: Math.round(box.height),
    label: at('span'),
    value: at('b'),
    note: at('small'),
  };
}

/** The same row as the export draws it, read back out of the SVG. */
export function factsInExport(svg) {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const label = [...doc.querySelectorAll('text')].find((t) => norm(t.textContent) === 'WORKING WINDOW');
  if (!label) return null;
  const labelY = parseFloat(label.getAttribute('y'));
  const labelX = parseFloat(label.getAttribute('x'));
  // A cell's three lines share an x. Without that, every neighbouring cell's label
  // shares this baseline and gets collected instead of the value and note below it.
  const column = [...doc.querySelectorAll('text')]
    .map((t) => ({ text: norm(t.textContent), y: parseFloat(t.getAttribute('y')), x: parseFloat(t.getAttribute('x')) }))
    .filter((t) => Number.isFinite(t.y) && Math.abs(t.x - labelX) < 1 && t.y >= labelY && t.y < labelY + 90)
    .sort((a, b) => a.y - b.y);
  const rect = [...doc.querySelectorAll('rect')]
        .map((r) => ({
      y: parseFloat(r.getAttribute('y')),
      h: parseFloat(r.getAttribute('height')),
      w: parseFloat(r.getAttribute('width')),
    }))
    // A cell divider is 1px wide and sits in this same band; only width tells
    // the frame apart from the lines drawn inside it.
    .filter((r) => Number.isFinite(r.y) && Number.isFinite(r.h) && Number.isFinite(r.w)
      && r.w > 100 && r.y < labelY && r.y > labelY - 40)
    .sort((a, b) => b.y - a.y)[0];
  const top = rect ? rect.y : labelY;
  return {
    height: rect ? Math.round(rect.h) : null,
    lines: column.slice(0, 3).map((t) => ({ text: t.text, baselineFromCellTop: Math.round(t.y - top) })),
  };
}

/** The same gaps as the export lays them out, from the numbers it actually draws with. */
export function spacingInExport(svg) {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const caps = [...doc.querySelectorAll('text')].filter((t) => /^(LINES OF CODE|PROJECTS BY)/.test(norm(t.textContent)));
  const groups = [...doc.querySelectorAll('g[transform]')]
    .map((g) => {
      const m = /translate\(([\d.-]+) ([\d.-]+)\)/.exec(g.getAttribute('transform'));
      return m ? { g, x: parseFloat(m[1]), y: parseFloat(m[2]) } : null;
    })
    .filter(Boolean);
  const gaps = [];
  caps.forEach((cap, i) => {
    const capY = parseFloat(cap.getAttribute('y'));
    const capX = parseFloat(cap.getAttribute('x'));
    // Both charts start at the same y now, so the one under a caption is the one that
    // shares its column: match on x, not on being the next thing down the page.
    const below = groups
      .filter((o) => o.y > capY && Math.abs(o.x - capX) < 1)
      .sort((a, b) => a.y - b.y)[0];
    if (!below) return;
    // capY is a baseline; the page measures from the caption's box top, 12px above it.
    gaps.push({ name: `caption -> body (${i + 1})`, px: Math.round(below.y - (capY - 12)) });
    // No height here to match the page's: a bar is a <path>, which has no box to read,
    // and the group draws no background. The page reports its own height for the eye;
    // the span both destinations can state the same way is the one above.
  });
  return gaps;
}

/** Console entry point: `import('/audit.js').then(m => m.report(model, story))`. */
export async function report(model, story, opts = {}) {
  // The image is always a 1200px render. Compared against a page narrow enough to have
  // switched to its portrait charts and its phone type sizes, every one of those
  // differences reports as drift — they are the responsive design, not a fault.
  if (window.innerWidth < 900) {
    console.warn(`window is ${window.innerWidth}px: widen it past 900 before trusting this — `
      + 'below that the page is drawing its portrait layouts and the export is not.');
  }
  const r = await auditTypography(model, story, opts);
  if (r.ok) console.log(`typography matches — ${r.pageTexts} page strings checked against ${r.exportTexts} in the export`);
  else console.table(r.rows);
  return r;
}
