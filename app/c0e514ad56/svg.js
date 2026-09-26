/**
 * One renderer, two destinations.
 *
 * Every chart emits SVG. The dashboard drops that SVG straight into the page; the export
 * packs the same fragments into one document and rasterises it. Nothing is drawn twice,
 * so a tweak to a chart shows up in both places by construction.
 *
 * Rasterising needs the fonts carried inside the SVG as data URIs — an external @font-face
 * is ignored once the markup is detached from the page, and text silently falls back to a
 * system face. They are fetched once and cached.
 */
import { parseInline } from './model.js';
import { FONT, MONO, SUNK } from './theme.js';

// Resolved against this module, not the page: the exported site keeps the app in a
// versioned directory of its own, so the fonts sit beside the code, not beside
// index.html. A site uploaded into a subdirectory still finds them either way.
const beside = (path) => new URL(path, import.meta.url).href;
const FACES = [
  { family: 'LINE Seed JP', weight: 400, path: beside('fonts/line-seed-jp-latin-400-normal.woff2') },
  { family: 'LINE Seed JP', weight: 700, path: beside('fonts/line-seed-jp-latin-700-normal.woff2') },
  { family: 'LINE Seed JP', weight: 800, path: beside('fonts/line-seed-jp-latin-800-normal.woff2') },
  { family: 'Blinker', weight: 400, path: beside('fonts/blinker-latin-400-normal.woff2') },
];

let facePromise = null;
let cssPromise = null;

/**
 * The stylesheet, at the version this module was loaded at.
 *
 * The exported site keeps the app under app/<hash>/, so the stylesheet beside this
 * module is the one that shipped with it. `reportcard run` versions by query instead,
 * `?v=…` on every module, and the tag is read off this module's URL so this fetch asks
 * for the same URL the page loaded rather than a plain `style.css` a browser may still
 * hold an old copy of.
 */
const STYLESHEET = beside(`style.css${new URL(import.meta.url).search}`);

/**
 * Everything the exported image reads from style.css must come from the base rules.
 *
 * The rule matchers below are flat: they pair a selector with the declarations between
 * the next braces, which cannot see that a rule is nested inside an at-rule. A `@media`
 * block therefore reads as a run of ordinary rules, and — being later in the file — its
 * declarations win. That is how a phone-sized `.card { padding: 16px }` silently became
 * the padding of a 1200px-wide PNG. The image has one fixed width and no viewport, so
 * responsive overrides are never its business: drop every at-rule block, braces
 * balanced, before parsing anything.
 */
function stripAtRules(css) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@', i);
    if (at < 0) return out + css.slice(i);
    const open = css.indexOf('{', at);
    const semi = css.indexOf(';', at);
    // An at-rule with no block at all (@import, @charset) ends at its semicolon.
    if (open < 0 || (semi >= 0 && semi < open)) {
      out += css.slice(i, at);
      i = semi < 0 ? css.length : semi + 1;
      continue;
    }
    out += css.slice(i, at);
    let depth = 0;
    let j = open;
    for (; j < css.length; j += 1) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}' && (depth -= 1) === 0) break;
    }
    i = j + 1;
  }
  return out;
}


/**
 * The chart CSS, carried into the exported document.
 *
 * Several renderers leave fill to the stylesheet — `.g-hit { fill: transparent }` most
 * consequentially, since without it SVG's default fill is black and the hit-rects paint
 * over the whole gantt. Text colours, the sankey's link opacity and its label halo are all
 * CSS too. On the page these come from style.css; a detached document has no stylesheet, so
 * the rules it needs travel with it.
 */
async function chartCss() {
  if (!cssPromise) {
    cssPromise = fetch(STYLESHEET)
      .then((res) => {
        if (!res.ok) throw new Error(`style.css: ${res.status}`);
        return res.text();
      })
      .then((text) => {
        // Comments go first. The matcher below treats everything between } and {
        // as the selector, so a comment sitting above a rule becomes part of that
        // selector and the rule silently fails the keep test. That is how the
        // export lost svg text:not([font-family]) -- the face for every
        // class-styled text, which is all of the gantt -- and .dial-cap, the
        // moment either rule grew an explanation above it.
        const css = stripAtRules(text.replace(/\/\*[\s\S]*?\*\//g, ''));
        // Only the rules that style SVG internals; layout rules would do nothing here.
        // An allowlist, so a chart whose classes start with anything new must be added
        // to it, or its CSS-only styling (a fill, a halo) will be missing from the image
        // while looking right on the page. The page-vs-image audit is what catches that.
        const keep = /^(svg |\.gantt|\.g-|\.sankey|\.s-|\.compare|\.c-axis|\.c-end|\.c-grid|\.c-line|\.c-x|\.dial\b|\.dial |\.k-|\.matrix|\.heat)/;
        const rules = [];
        for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
          const sel = m[1].trim().replace(/\s+/g, ' ');
          if (sel.startsWith('@') || sel.includes(':hover') || sel.includes(':root')) continue;
          if (sel.split(',').some((one) => keep.test(one.trim()))) rules.push(`${sel}{${m[2].trim()}}`);
        }
        return rules.join('');
      })
      // An image without the chart CSS is still an image, so this export goes ahead —
      // but the failure is not remembered, and the next export fetches again rather
      // than drawing unstyled charts until the page is reloaded.
      .catch(() => {
        cssPromise = null;
        return '';
      });
  }
  return cssPromise;
}

async function faceCss() {
  if (!facePromise) {
    facePromise = Promise.all(FACES.map(async (f) => {
      const res = await fetch(f.path);
      if (!res.ok) throw new Error(`font ${f.path}: ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
      return `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};`
        + `src:url(data:font/woff2;base64,${btoa(bin)}) format('woff2');}`;
    })).then((parts) => parts.join(''))
      // One font that fails to load fails this export, but it is not remembered: kept,
      // the rejected promise would have failed every export until the page was reloaded.
      .catch((e) => {
        facePromise = null;
        throw e;
      });
  }
  return facePromise;
}

/**
 * Text metrics without a DOM. One scratch context serves every chart, so the page and the
 * exported image agree about what fits — measuring after render meant they never could.
 */
let scratch;
export function measure(str, weight, size, family = FONT, style = '') {
  if (!scratch) scratch = document.createElement('canvas').getContext('2d');
  scratch.font = `${style} ${weight} ${size}px ${family}`.trim();
  return scratch.measureText(str).width;
}

/**
 * How far a string's first glyph holds its ink clear of the text origin, in px.
 *
 * Every glyph carries a left side bearing, and at title sizes it stops being invisible:
 * Blinker's flat-stemmed capitals sit 0.072em inside the origin — 4.6px at 64px, against
 * about 1.4px for 15px body copy — so a title set at the same x as the paragraph under it
 * reads as an indent. Subtracting this puts the ink itself on the margin.
 *
 * Measured by drawing the glyph and looking for its first lit pixel, which is slower than
 * asking for it but is the only answer both engines give. TextMetrics has a field for
 * exactly this — actualBoundingBoxLeft — and WebKit fills it with the advance box instead
 * of the ink box: Chromium says -4.608 for the title where Safari says 0. Trusting it
 * left Safari with the full 4.6px indent while Chromium looked right, which is the worst
 * shape a bug can take. Pixels are pixels in both.
 *
 * Measured per string rather than kept as a constant, because side bearings are per
 * glyph: "Mar" needs the whole 4.6px and "Apr" needs half a pixel, so one number would
 * overhang the second title to straighten the first.
 */
let inkProbe;
export function inkInset(str, { weight = 400, size = 100, family = FONT } = {}) {
  // The leftmost ink of a line is the first glyph's: nothing after it can reach back
  // past its origin, so one character is the whole question and keeps the probe small.
  const head = String(str).trim().charAt(0);
  if (!head) return 0;
  // Drawn large and scaled down, so the pixel grid costs a fraction of a pixel at the
  // size actually being set. PAD leaves room to the left for the italic and script faces
  // whose ink starts before their origin.
  const REF = 256;
  const PAD = 64;
  const w = PAD + REF;
  const h = Math.round(REF * 1.6);
  if (!inkProbe) inkProbe = document.createElement('canvas');
  // Assigning the size also clears whatever the last call drew.
  inkProbe.width = w;
  inkProbe.height = h;
  const ctx = inkProbe.getContext('2d', { willReadFrequently: true });
  ctx.font = `${weight} ${REF}px ${family}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#000';
  ctx.fillText(head, PAD, Math.round(REF * 1.25));
  const { data } = ctx.getImageData(0, 0, w, h);
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) {
      // Any coverage at all is ink; an antialiased edge is still the edge.
      if (data[(y * w + x) * 4 + 3] > 0) return ((x - PAD) * size) / REF;
    }
  }
  // A glyph with no ink of its own — a space, most likely — has nothing to hang by.
  return 0;
}

/** A face's ascent and descent at a size, from the font itself. */
export function measureMetrics(size, weight = 400, family = FONT) {
  if (!scratch) scratch = document.createElement('canvas').getContext('2d');
  scratch.font = `${weight} ${size}px ${family}`;
  const m = scratch.measureText('Hxy');
  return { ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent };
}

/**
 * Where the text baseline sits inside a CSS line box, measured from the box's top.
 *
 * CSS centres the font's ascent+descent in the line box (half-leading) and puts the
 * baseline an ascent below that. Fitting a ratio to ink extents does not work: ink
 * depends on which glyphs are in the string, so "WORKING WINDOW" and "3pm - 3am" sit
 * differently in identical boxes. The font's own metrics do not have that problem.
 */
export function baselineIn(lineBox, size, weight = 400, family = FONT) {
  if (!scratch) scratch = document.createElement('canvas').getContext('2d');
  scratch.font = `${weight} ${size}px ${family}`;
  const m = scratch.measureText('Hxy');
  const ascent = m.fontBoundingBoxAscent;
  const descent = m.fontBoundingBoxDescent;
  return (lineBox - (ascent + descent)) / 2 + ascent;
}

/**
 * Greedy wrap at spaces, into lines no wider than `room`.
 *
 * Returns null rather than a best effort when it cannot do the job — a single word
 * wider than the room, or more lines than `maxLines`. It never truncates and never adds
 * an ellipsis: callers depend on the null to fall back to something else (a smaller
 * size, a shorter label, no label at all), and a quietly clipped line would hide the
 * problem from them. Paragraph breaks survive as an empty line between paragraphs.
 */
export function wrapWords(str, { weight = 400, size = 12, room, maxLines = Infinity }) {
  // A newline is a break someone typed, not whitespace to reflow. Any run of newlines is
  // one paragraph break and always draws a blank line, so a single \n and a \n\n come out
  // the same -- the textarea shows no gap between paragraphs, so what you typed there
  // can't tell you what you'd get, and doubling up shouldn't be the way to earn space.
  const paragraphs = String(str).split(/\r?\n+/).map((t) => t.trim()).filter(Boolean);
  const lines = [];
  for (const [i, paragraph] of paragraphs.entries()) {
    if (i) lines.push('');
    const words = paragraph.split(/\s+/).filter(Boolean);
    // The guard covers every paragraph, not just the first: an unbreakable word in the
    // second one has to fail the whole call, or the caller's fallback never fires.
    const longest = words.reduce((a, b) => (b.length > a.length ? b : a), '');
    if (measure(longest, weight, size) > room) return null;
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (measure(next, weight, size) <= room) line = next;
      else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
  }
  return lines.length > maxLines ? null : lines;
}

/**
 * Each screenshot, decoded, as a Map from its URL to { href, width, height, ratio }.
 *
 * Every image is decoded first for its true dimensions, which is the main reason this
 * exists: guessing an aspect ratio is how a 16:9 screenshot ends up drawn at 16:10.
 * `href` is what to draw from, and it depends on the destination. The page can use the
 * URL as it is; a rasterised SVG cannot — detached markup never fetches external files,
 * and the screenshot would vanish from the PNG as silently as an unembedded font — so
 * `inline` fetches each one into a data URI instead.
 *
 * One at a time, not cached, and an image that will not load is simply absent from the
 * Map: it costs its highlight the picture, never the export.
 */
export async function imageSources(urls, { inline = false } = {}) {
  const out = new Map();
  for (const url of new Set(urls.filter(Boolean))) {
    try {
      // Decoding gives the true aspect ratio. Guessing one is how a 16:9 screenshot ends
      // up drawn at 16:10 — wrong for exactly the files that differ from the common case.
      const probe = new Image();
      probe.src = url;
      await probe.decode();
      const w = probe.naturalWidth || 1;
      const h = probe.naturalHeight || 1;
      let href = url;
      if (inline) {
        const res = await fetch(url);
        if (!res.ok) continue;
        const bytes = new Uint8Array(await res.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
        href = `data:${res.headers.get('content-type') || 'image/png'};base64,${btoa(bin)}`;
      }
      out.set(url, { href, width: w, height: h, ratio: h / w });
    } catch {
      // A screenshot that will not load costs the highlight its picture, not the export.
    }
  }
  return out;
}

/** XML-safe text for anything interpolated into SVG. */
export const x = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Attribute-safe value. The font stacks carry double quotes ("LINE Seed JP", ...), which
 * end the attribute early: HTML parsing shrugs that off, XML refuses the whole document,
 * so the page looked right while the exported SVG would not decode at all.
 */
const attr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, "'").replace(/</g, '&lt;');

let metricsPromise = null;

/**
 * Every pixel value one property sets, in the order written — `padding: 20px 22px 18px`
 * gives [20, 22, 18]. `decls` is a rule's declaration text, not an object: these are
 * read out of the stylesheet as written, never computed. Returns `fallback` when the
 * property is absent or sets nothing in pixels.
 */
const pxValues = (decls, prop, fallback) => {
  const name = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|;)\\s*${name}\\s*:([^;]+)`).exec(decls);
  if (!m) return fallback;
  const nums = m[1].trim().match(/-?[\d.]+px/g);
  return nums ? nums.map((n) => parseFloat(n)) : fallback;
};

/** The first pixel value a property sets, or `fallback`. What almost every caller wants. */
const firstPx = (decls, prop, fallback) => {
  const v = pxValues(decls, prop, null);
  return v ? v[0] : fallback;
};

/**
 * One group of tokens per function, because they are read the same way but mean
 * different things — and as one object literal of eighty lines, no reader could tell
 * where a group began. `R` looks a selector up in the parsed stylesheet; the fallbacks
 * are what the image used before the stylesheet was the source of truth.
 */
function cardTokens(R, pad) {
  return {
    card: {
      ...pad('.card', { top: 20, right: 22, bottom: 18, left: 22 }),
      radius: firstPx(R('.card'), 'border-radius', 14),
      gap: firstPx(R('.card'), 'margin-bottom', 16),
    },
    cardHead: { size: firstPx(R('.card-head h2'), 'font-size', 18), noteSize: firstPx(R('.card-head .muted'), 'font-size', 13),
                weight: weightOf(R('.card-head h2'), 400),
                marginBottom: firstPx(R('.card-head'), 'margin-bottom', 16) },
    cardFoot: { size: firstPx(R('.card-foot'), 'font-size', 12.5),
                marginTop: firstPx(R('.card-foot'), 'margin', 10) },
  };
}

/**
 * The KPI tile. Its vertical rhythm is three stacked blocks, so the image needs the
 * line-heights as well as the sizes: the label and delta inherit body's, the value sets
 * its own, and the margins stack the blocks inside the padding.
 */
function kpiTokens(R, pad, bodyLineHeight) {
  return {
    ...pad('.kpi', { top: 13, right: 14, bottom: 11, left: 14 }),
    radius: firstPx(R('.kpi'), 'border-radius', 12),
    gap: firstPx(R('.kpis'), 'gap', 10),
    labelSize: firstPx(R('.kpi-label'), 'font-size', 11.5),
    valueSize: firstPx(R('.kpi-value'), 'font-size', 30),
    unitSize: firstPx(R('.kpi-value small'), 'font-size', 14),
    deltaSize: firstPx(R('.kpi-delta'), 'font-size', 13),
    valueWeight: weightOf(R('.kpi-value'), 400),
    unitWeight: weightOf(R('.kpi-value small'), 400),
    deltaWeight: weightOf(R('.kpi-delta'), 400),
    lineHeight: bodyLineHeight,
    valueLineHeight: ratio(R('.kpi-value'), 'line-height', 1.1),
    valueMargin: firstPx(R('.kpi-value'), 'margin-top', 6),
    deltaMargin: firstPx(R('.kpi-delta'), 'margin-top', 4),
  };
}

/** The schedule row under the working-hours charts. */
function factsTokens(R, pad, bodyLineHeight) {
  return {
    ...pad('.fact', { top: 11, right: 14, bottom: 10, left: 14 }),
    marginTop: firstPx(R('.facts'), 'margin-top', 18),
    radius: firstPx(R('.facts'), 'border-radius', 10),
    labelSize: firstPx(R('.fact span'), 'font-size', 11),
    valueSize: firstPx(R('.fact b'), 'font-size', 19),
    noteSize: firstPx(R('.fact small'), 'font-size', 11.5),
    valueWeight: weightOf(R('.fact b'), 400),
    // .fact b { margin-top } separates the value from the label.
    valueGap: firstPx(R('.fact b'), 'margin-top', 3),
    // Inherited, so it appears in no .fact rule: the three children are blocks, and
    // their line boxes -- not their font sizes -- set the cell's height.
    lineHeight: bodyLineHeight,
  };
}

/** font-weight is a bare number, not a px value, so it needs its own reader. */
function weightOf(decls, fallback) {
  const m = /(?:^|;)\s*font-weight\s*:\s*(\d+)/.exec(decls);
  return m ? Number(m[1]) : fallback;
}

/** A unitless ratio, such as line-height. */
function ratio(decls, prop, fallback) {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([\\d.]+)`).exec(decls);
  return m ? parseFloat(m[1]) : fallback;
}

/**
 * The spacing and type sizes the exported image needs, read out of style.css.
 *
 * Read from the stylesheet's text, not from computed style: the image is drawn at one
 * fixed width with no DOM of its own to compute against, and the page at hand may be a
 * phone whose responsive rules would be the wrong answer. So this fetches style.css,
 * drops comments and every at-rule, maps each selector to its declarations, and pulls
 * out the handful of values the painter uses — card padding and radius, KPI and fact
 * type sizes, gaps and margins — each with the value it had before the stylesheet was
 * the source, for when a rule goes missing.
 *
 * The charts already shared a renderer, but the space around them used to be
 * hand-typed numbers in the exporter, so editing .card padding moved the page and left
 * the image behind. Now the stylesheet is the single source for both.
 *
 * Returns null if the stylesheet cannot be read; the caller falls back to its own
 * copy of those values. A failure is not remembered, so the next export tries again.
 */
export async function stylesheetMetrics() {
  if (!metricsPromise) {
    metricsPromise = fetch(STYLESHEET)
      .then((res) => {
        if (!res.ok) throw new Error(`style.css: ${res.status}`);
        return res.text();
      })
      .then((raw) => {
        // Strip comments first: a /* ... */ above a selector otherwise becomes part of
        // the captured selector, and that rule goes missing from the map entirely.
        const text = stripAtRules(raw.replace(/\/\*[\s\S]*?\*\//g, ''));
        const rules = new Map();
        for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
          const sel = m[1].trim().replace(/\s+/g, ' ');
          if (sel.startsWith('@')) continue;
          for (const one of sel.split(',')) rules.set(one.trim(), m[2].trim());
        }
        const R = (sel) => rules.get(sel) || '';
        // body's unitless line-height cascades into every block that doesn't set one.
        const bodyLineHeight = (() => {
          const decl = rules.get('body') || rules.get(':root') || '';
          const direct = ratio(decl, 'line-height', null);
          if (direct) return direct;
          // body says `font: 15px/1.5 var(--font)`; the ratio lives in the shorthand.
          const f = /(?:^|;)\s*font\s*:[^;]*?\d[\d.]*px\s*\/\s*([\d.]+)/.exec(decl);
          return f ? parseFloat(f[1]) : 1.5;
        })();
        // padding shorthand: 1, 2, 3 or 4 values, CSS order.
        const pad = (sel, fb) => {
          const v = pxValues(R(sel), 'padding', null);
          if (!v) return fb;
          const [t, r = t, b = t, l = r] = v;
          return { top: t, right: r, bottom: b, left: l };
        };
        return {
          ...cardTokens(R, pad),
          kpi: kpiTokens(R, pad, bodyLineHeight),
          breakdowns: { gap: firstPx(R('.breakdowns'), 'gap', 24),
                        captionSize: firstPx(R('.breakdown figcaption'), 'font-size', 12),
                        captionMargin: firstPx(R('.breakdown figcaption'), 'margin-bottom', 8) },
          facts: factsTokens(R, pad, bodyLineHeight),
          dialCap: { size: firstPx(R('.dial-cap'), 'font-size', 12.5),
                     marginTop: firstPx(R('.dial-cap'), 'margin', 8) },
          legend: { size: firstPx(R('.legend'), 'font-size', 12),
                    marginTop: firstPx(R('.legend'), 'margin-top', 12) },
        };
      })
      .catch(() => {
        metricsPromise = null;
        return null;
      });
  }
  return metricsPromise;
}

/** A <text> element. Same call shape as the old canvas `text()` so charts read the same. */
export const svgText = (str, px, py, { size = 12, weight = 400, fill = '#16150f', anchor = 'start', mono = false, family = null, baseline = 'alphabetic', cls = '', tracking = 0 } = {}) =>
  `<text x="${px.toFixed(1)}" y="${py.toFixed(1)}" font-family="${attr(family || (mono ? MONO : FONT))}" font-size="${size}"`
  + ` font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"`
  + (baseline !== 'alphabetic' ? ` dominant-baseline="${baseline}"` : '')
  + (tracking ? ` letter-spacing="${tracking}"` : '')
  + (cls ? ` class="${cls}"` : '') + `>${x(str)}</text>`;

// Code is set in the mono face a step smaller, on a pill padded like `code` on the page.
const CODE_SCALE = 0.88;
const CODE_PAD = 4;
const CODE_ASCENT = 0.86;
const CODE_HEIGHT = 1.2;

/** How wide one piece of a word draws: code in the mono face plus its pill's padding. */
export const pieceWidth = (piece, size, weight = 400) => (piece.code
  ? measure(piece.text, 400, size * CODE_SCALE, MONO) + CODE_PAD * 2
  : measure(piece.text, piece.bold ? 700 : weight, size, FONT, piece.italic ? 'italic' : ''));
const wordWidth = (word, size) => word.reduce((n, piece) => n + pieceWidth(piece, size), 0);
const samePiece = (a, b) => a.bold === b.bold && a.italic === b.italic && a.code === b.code;

/**
 * The paragraph as words, where a word is a list of pieces.
 *
 * Emphasis does not respect word boundaries: `**commits**,` is one word made of a bold
 * piece and a plain comma, and it has to wrap, measure and draw as one. Splitting on
 * runs instead of on spaces is what put a space in front of that comma. A code span is
 * never split at its spaces: `krapow init win` is one thing on one pill, and wraps whole.
 */
function runWords(text) {
  const words = [];
  let word = [];
  for (const run of parseInline(text)) {
    if (run.code) {
      word.push({ text: run.text, code: true });
      continue;
    }
    for (const [i, part] of run.text.split(/\s+/).entries()) {
      if (i && word.length) {
        words.push(word);
        word = [];
      }
      if (part) word.push({ text: part, bold: run.bold, italic: run.italic });
    }
  }
  if (word.length) words.push(word);
  return words;
}

/**
 * Prose wrapped to a column, as lines of styled words, for svgRuns to draw.
 *
 * Not wrapWords: that measures one weight for the whole string, and a sentence with a
 * bold phrase or a code span in it is two faces or more. Each piece is measured as it
 * will draw, so a line fills the column no matter what is marked up inside it.
 *
 * A word too wide for the column is chopped rather than refused — a pasted URL would
 * otherwise cost the whole intro. The breaks land as spaces, which shows in a URL and
 * never in the prose people actually write. `breaks` is what separates paragraphs,
 * each drawn as a blank line: a blank line in the report's prose, any newline in a
 * project description, whose textarea shows no gap to type.
 */
export function wrapRuns(text, { size, room, breaks = /\n{2,}/ }) {
  if (!text) return [];
  const space = measure(' ', 400, size);
  const chop = (word) => {
    const out = [];
    let head = [];
    for (const piece of word) {
      for (const ch of piece.text) {
        const last = head[head.length - 1];
        const next = last && samePiece(last, piece)
          ? [...head.slice(0, -1), { ...last, text: last.text + ch }]
          : [...head, { ...piece, text: ch }];
        if (head.length && wordWidth(next, size) > room) {
          out.push(head);
          head = [{ ...piece, text: ch }];
        } else head = next;
      }
    }
    if (head.length) out.push(head);
    return out;
  };

  const lines = [];
  const paragraphs = String(text).split(breaks).map((t) => t.trim()).filter(Boolean);
  for (const [i, para] of paragraphs.entries()) {
    if (i) lines.push([]);
    let line = [];
    let used = 0;
    for (const word of runWords(para)) {
      for (const part of (wordWidth(word, size) > room ? chop(word) : [word])) {
        const w = wordWidth(part, size);
        if (line.length && used + space + w > room) {
          lines.push(line);
          line = [];
          used = 0;
        }
        used += (line.length ? space : 0) + w;
        line.push(part);
      }
    }
    if (line.length) lines.push(line);
  }
  return lines;
}

/**
 * A line of words that are not all the same weight.
 *
 * Emphasis in prose means one line can carry upright and bold together, so the line is
 * one <text> with a <tspan> per emphasised word — the element still reads back as the
 * whole line, which is what the page/export audit matches on.
 *
 * `words` is one word per entry and a word is a list of pieces, the way the wrap
 * measured them: exactly one space between words, none between the pieces of one, so
 * `**commits**,` keeps its comma tight. The space is drawn outside the tspan, unstyled,
 * because that is the space the wrap measured; xml:space keeps SVG from swallowing it.
 */
export function svgRuns(words, px, py, { size = 12, weight = 400, fill = '#16150f', family = null } = {}) {
  // A code piece sits on a pill, like `code` on the page, so it is drawn at a position
  // measured here rather than left to flow: the pill needs its x, and the text after it
  // has to start past the pill's padding, which SVG's own flow knows nothing about.
  const space = measure(' ', weight, size);
  const pills = [];
  let cursor = px;
  let placeNext = false;
  const body = words.map((word, i) => {
    let out = '';
    if (i) {
      out += ' ';
      cursor += space;
    }
    for (const piece of word) {
      const w = pieceWidth(piece, size, weight);
      if (piece.code) {
        pills.push(svgRect(cursor, py - size * CODE_ASCENT, w, size * CODE_HEIGHT, { fill: SUNK, r: 4 }));
        out += `<tspan x="${(cursor + CODE_PAD).toFixed(1)}" font-family="${attr(MONO)}" font-size="${(size * CODE_SCALE).toFixed(2)}">${x(piece.text)}</tspan>`;
        placeNext = true;
      } else {
        const marks = (piece.bold ? ' font-weight="700"' : '') + (piece.italic ? ' font-style="italic"' : '')
          + (placeNext ? ` x="${cursor.toFixed(1)}"` : '');
        out += marks ? `<tspan${marks}>${x(piece.text)}</tspan>` : x(piece.text);
        placeNext = false;
      }
      cursor += w;
    }
    return out;
  }).join('');
  return pills.join('')
    + `<text x="${px.toFixed(1)}" y="${py.toFixed(1)}" font-family="${attr(family || FONT)}" font-size="${size}"`
    + ` font-weight="${weight}" fill="${fill}" xml:space="preserve">${body}</text>`;
}

export const svgRect = (px, py, w, h, { fill, r = 0, stroke = '', sw = 0 } = {}) =>
  `<rect x="${px.toFixed(2)}" y="${py.toFixed(2)}" width="${Math.max(0, w).toFixed(2)}" height="${Math.max(0, h).toFixed(2)}"`
  + (r ? ` rx="${r}"` : '') + ` fill="${fill}"` + (stroke ? ` stroke="${stroke}" stroke-width="${sw}"` : '') + '/>';

/** Wrap a document around fragments so it can stand alone as a file or an <img> source. */
export function svgDocument({ width, height, background, body, css = '' }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"`
    + ` width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<style>${css}</style>`
    + (background ? svgRect(0, 0, width, height, { fill: background }) : '')
    + body + '</svg>';
}

/**
 * Rasterise an SVG document into `canvas` at `scale`, and return its size.
 *
 * A detached document has no stylesheet and no fonts of its own, so three things are
 * injected into its <style> first: the fonts as data URIs, the chart rules from
 * style.css that style SVG internals, and the custom properties those rules refer to,
 * which would otherwise resolve against a :root that is not there. Without them the
 * text falls back to a system face and CSS-only fills go missing.
 *
 * The canvas stays untainted — the markup travels as a blob URL, so the PNG can still
 * be read back and downloaded.
 *
 * `cropHeight` keeps the top of the document and nothing else: the canvas is made that
 * tall and the image is drawn at full size, so the excess falls outside it. That is how
 * the share image takes the report's first screen without a second rendering path.
 */
export async function rasterise(svgMarkup, canvas, { width, height, scale = 2, cropHeight = null }) {
  const [css, charts] = await Promise.all([faceCss(), chartCss()]);
  // Custom properties resolve against :root on the page; a detached document has none, so
  // the handful the chart rules reference are declared inline.
  const vars = ':root{--font:' + FONT.replace(/"/g, "'") + ';--ink:#16150f;--ink-2:#55524a;--ink-3:#86817a;'
    + '--card:#ffffff;--paper:#faf8f3;--rule:#e4dfd3;--rule-strong:#cdc6b6;--accent:#1d1b19;--tomato:#d2552f;--g-2:#a69f93;--g-3:#625c54;--sunk:#f3f0e8;}';
  const withFonts = svgMarkup.replace('<style>', `<style>${css}${vars}${charts}`);
  const blob = new Blob([withFonts], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const shown = cropHeight ?? height;
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(shown * scale);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, width, shown);
    ctx.drawImage(img, 0, 0, width, height);
  } finally {
    URL.revokeObjectURL(url);
  }
  return { width, height };
}

/** A status dot: filled for a result, a hollow ring while there is none. */
export const statusDot = (res, cx, cy, r) => (res.hollow
  ? `<circle cx="${cx}" cy="${cy}" r="${r - 0.75}" fill="#ffffff" stroke="${res.color}" stroke-width="1.5"/>`
  : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${res.color}"/>`);
