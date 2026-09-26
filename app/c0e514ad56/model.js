// Pure data layer: periods, slicing, merged projects, totals. No DOM.

export const DAY_MS = 86400000;
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const toKey = (d) => d.toISOString().slice(0, 10);
export const parseKey = (key) => new Date(`${key.slice(0, 10)}T00:00:00Z`);
export const addDays = (key, n) => toKey(new Date(parseKey(key).getTime() + n * DAY_MS));
export const daysBetween = (a, b) => Math.round((parseKey(b) - parseKey(a)) / DAY_MS);
export const today = () => toKey(new Date());

export const fmtNum = (n) => Number(n).toLocaleString('en-US');

/** One decimal, unless rounding to one decimal would reach `whole` and not need it. */
const round1 = (v, whole) =>
  (Math.abs(Number(v.toFixed(1))) >= whole ? v.toFixed(0) : v.toFixed(1));

/**
 * A number short enough to sit inside a KPI tile beside its change: 1.2M, 14.2k, 9,870.
 * fmtBig only abbreviates at 100k, so a five-digit previous value printed in full and
 * overflowed the tile; this caps the width at every magnitude, from 10k up.
 */
export const fmtTight = (n) => {
  const v = Number(n);
  const a = Math.abs(v);
  // Round before choosing the unit: 999,999 rounded to whole thousands is 1000k, which
  // is both wrong and wider than the 1.0M it should read.
  if (a >= 999.5e3) return `${round1(v / 1e6, 10)}M`;
  if (a >= 9.95e3) return `${round1(v / 1e3, 100)}k`;
  return fmtNum(v);
};

/**
 * A headline number, compact only once it stops fitting: 1.24M from a million, 128k
 * from a hundred thousand, and every digit below that — 82,961 stays 82,961. The
 * thresholds are deliberately high; a KPI that needs to stay narrow at every size wants
 * fmtTight instead.
 */
export const fmtBig = (n) => {
  const v = Number(n);
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e5) return `${Math.round(v / 1e3)}k`;
  return fmtNum(v);
};
export const fmtDay = (key) => {
  const d = parseKey(key);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
};
export const fmtMonth = (key) => {
  const d = parseKey(key);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
export const fmtRange = (from, to) => `${fmtDay(from)} – ${fmtDay(to)}`;
export const fmtSpan = (first, last) => {
  if (!first) return '';
  const a = fmtMonth(first);
  const b = fmtMonth(last);
  return a === b ? a : `${a} – ${b}`;
};
export const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------------ results */

// Order is load-bearing: it's the order results stack in the sankey. The colours are the
// Graphite status palette, checked pairwise under deuteranopia, protanopia and tritanopia.
// Paused and Abandoned are the closest pair for normal vision, which holds up only because
// every use is labelled: never show one of these without its label or a legend.
/**
 * One axis only: where the project stands now. Shipping is orthogonal — plenty of things
 * are released and ongoing and were never announced — and GitHub releases already record
 * it. "Experiment" is a kind of completed, ongoing or abandoned, not a state of its own,
 * and "personal use" is what a project is for, which is a category.
 */
export const RESULTS = [
  { id: 'ongoing', label: 'Ongoing', color: '#d2552f' },
  { id: 'completed', label: 'Completed', color: '#2f6f9a' },
  { id: 'paused', label: 'Paused', color: '#e3ae3a' },
  { id: 'abandoned', label: 'Abandoned', color: '#b3aba1' },
];
// No result yet is a texture, not a fifth colour: every distinct hue is taken, and any
// light grey sits on top of Abandoned. Hollow reads as "not filled in yet", tells apart by
// shape for colourblind readers and in print, and fills in once a result is recorded.
// `color` is the outline (and the sankey's hatch), never a fill.
export const UNSET = { id: '', label: 'No result yet', color: '#8c857b', hollow: true };
export const resultOf = (id) => RESULTS.find((r) => r.id === id) || UNSET;
/** A status dot as inline CSS: filled for a result, a hollow ring while there is none. */
export const dotCss = (r) => (r.hollow ? `background:#fff;box-shadow:inset 0 0 0 1.5px ${r.color}` : `background:${r.color}`);

// Suggestions only — the field takes free text, so anyone can invent their own.
export const CATEGORIES = [
  'Developer tools', 'Data & analytics', 'Game', 'Infrastructure',
  'Web', 'AI & ML', 'Code quality', 'Content', 'Hardware', 'Personal', 'Experiment',
];

// Why a project ended up the way it did. Phrased the way people actually say it.
export const REASONS = {
  ongoing: ['Still building', 'Continuing to refine', 'Maintenance mode', 'Use every day', 'Slow burn'],
  completed: ['Shipped, then moved on', 'Never told anyone', 'Did what I needed', 'Proved the point', 'Disproved the point'],
  paused: ['Back burner', 'Waiting on something else', 'Lost momentum', 'Will return to it'],
  abandoned: ['Lost interest', 'Hit a wall', 'Proven uninteresting', 'Scope got away from me',
    'Unclear ownership', 'Something better already existed', 'It was a bad idea', 'Life happened'],
};
export const reasonsFor = (resultId) => REASONS[resultId] || [];

/** Your edit if you made one, else whatever GitHub has. */
export const descriptionOf = (unit, story) => meta(story, unit.key).description?.trim() || unit.description || '';

/**
 * Where a reader can go see the project: only a link you gave it, never GitHub's
 * homepage. A bare "fussy.app" gets https:// in front, and anything that isn't http(s)
 * comes back empty — this ends up as an href on a page other people open.
 */
export const linkOf = (unit, story) => {
  const raw = meta(story, unit.key).url?.trim() || '';
  if (!raw) return '';
  try {
    const u = new URL(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch {
    return '';
  }
};

/** A link as a reader should see it: no scheme, no www., no trailing slash. */
export const linkLabel = (href) => {
  const u = new URL(href);
  return (u.host.replace(/^www\./, '') + u.pathname.replace(/\/$/, '') + u.search + u.hash);
};
export const categoryOf = (unit, story) => meta(story, unit.key).category?.trim() || '';
export const reasonOf = (unit, story) => meta(story, unit.key).reason?.trim() || '';
export const isHighlighted = (unit, story) => meta(story, unit.key).highlight === true;

export const KPIS = [
  { key: 'commits', label: 'Commits' },
  { key: 'lines', label: 'Lines changed' },
  { key: 'activeDays', label: 'Active days' },
  { key: 'projects', label: 'Projects' },
  { key: 'newProjects', label: 'New projects' },
  { key: 'releases', label: 'Releases' },
  { key: 'streak', label: 'Longest streak', unit: 'days' },
];

// Every chart reads one of these; mixing them in a single view would make the
// numbers stop adding up.
export const METRICS = [
  { id: 'commits', label: 'Commits', noun: 'commits', landing: 'commits land' },
  { id: 'lines', label: 'Lines changed', noun: 'lines', landing: 'lines of code are committed' },
];
export const metricOf = (id) => METRICS.find((m) => m.id === id) || METRICS[0];

/**
 * The measure is chosen per section, not once for the whole report: commits answer
 * "how often did I show up", lines answer "how much changed", and the honest answer
 * differs by chart. `options.metric` is kept as the seed so a previously saved global
 * choice carries into every section instead of silently resetting.
 */
export const METRIC_SECTIONS = ['activity'];
/**
 * Only the activity heatmap carries a measure switch: it asks how often work landed, so
 * it defaults to commits. Language is always weighted by lines and categories are always
 * one vote per project, so neither has anything to switch. A saved global choice from the
 * old single toggle still wins over the default, and an explicit choice wins over both.
 */
const METRIC_DEFAULT = { activity: 'commits' };
export const metricFor = (story, section) =>
  metricOf(story?.options?.metrics?.[section] ?? story?.options?.metric ?? METRIC_DEFAULT[section]).id;
export function setMetric(story, section, id) {
  story.options.metrics = { ...(story.options.metrics || {}), [section]: metricOf(id).id };
}
/** Per-day totals for a unit under the chosen measure. */
export const daysOf = (unit, metric) => (metric === 'lines' ? unit.lines : unit.days);
/** A unit's total under the chosen measure. */
export const totalOf = (unit, metric) => (metric === 'lines' ? unit.linesChanged : unit.commits);
/** What one commit contributes under the chosen measure. */
export const weightOf = (entry, metric) => (metric === 'lines' ? entry[1] + entry[2] : 1);

/* ------------------------------------------------------------------ periods */

export const PRESETS = [
  { id: '6m', label: '6 months', months: 6 },
  { id: '12m', label: '12 months', months: 12 },
  { id: '18m', label: '18 months', months: 18 },
  { id: '24m', label: '2 years', months: 24 },
];
export const MAX_COMPARE = 3;

/** Presets roll with the calendar; custom ranges are fixed but never run past today. */
export function resolvePeriod(period) {
  const end = today();
  if (period?.preset === 'custom' && period.from && period.to) {
    let [from, to] = [period.from, period.to].sort();
    if (to > end) to = end;
    if (from > to) from = to;
    return { preset: 'custom', from, to };
  }
  const preset = PRESETS.find((p) => p.id === period?.preset) || PRESETS[1];
  const start = parseKey(end);
  start.setUTCMonth(start.getUTCMonth() - preset.months);
  return { preset: preset.id, from: addDays(toKey(start), 1), to: end };
}

export const periodLength = (p) => daysBetween(p.from, p.to) + 1;

/** Back-to-back periods of the same length, most recent first. */
export function previousPeriods(current, n) {
  const len = periodLength(current);
  const out = [];
  let to = addDays(current.from, -1);
  for (let i = 0; i < n; i++) {
    const from = addDays(to, -(len - 1));
    out.push({ from, to });
    to = addDays(from, -1);
  }
  return out;
}

/** Does the pulled history reach back far enough for this period and its comparisons? */
export function coverage(data, story) {
  const current = resolvePeriod(story.period);
  const previous = previousPeriods(current, story.compare);
  const needFrom = previous.length ? previous[previous.length - 1].from : current.from;
  if (!data) return { ok: false, needFrom, current, previous };
  const pulledFrom = data.from.slice(0, 10);
  return { ok: pulledFrom <= needFrom, needFrom, pulledFrom, current, previous };
}

/* -------------------------------------------------------------------- story */

export const emptyStory = () => ({
  version: 2,
  period: { preset: '12m' },
  compare: 1,
  groups: [],
  projects: {},
  // Ordered from the first save, whether or not anyone writes a word: see normalizeBlocks.
  blocks: normalizeBlocks([]),
  options: { realNames: false },
});

export function normalizeStory(raw) {
  const base = emptyStory();
  if (!raw || raw.version !== 2) return base;
  return {
    ...base,
    ...raw,
    compare: Math.max(0, Math.min(MAX_COMPARE, Number(raw.compare ?? base.compare))),
    intro: sanitizeProse(raw.intro) || undefined,
    blocks: normalizeBlocks(raw.blocks),
    options: { ...base.options, ...raw.options },
  };
}

export const meta = (story, key) => story.projects[key] || {};
export const ensureMeta = (story, key) => (story.projects[key] ||= {});

/* -------------------------------------------------------------------- prose */

/**
 * The report's sections, in the order they argue. One list, read by the page, by the
 * exported image and by the block list below — the order a report is laid out in is a
 * property of the report, not of whichever renderer happens to be drawing it.
 */
export const SECTION_ORDER = ['projects', 'highlights', 'activity', 'hours', 'types', 'effort', 'compare'];

/**
 * Charts that live inside a card rather than being one.
 *
 * Project types draws two: languages and categories. A single line above both of them
 * could only ever be about one, so each gets its own slot and the card gets none. They
 * are ordinary chart blocks in the stored list — everything that walks the list treats
 * them the same way, and the card is what knows they belong to it.
 */
export const SUBSLOTS = { types: ['types:language', 'types:category'] };
const CHART_ORDER = SECTION_ORDER.flatMap((id) => [id, ...(SUBSLOTS[id] || [])]);

/**
 * What an empty slot asks for.
 *
 * A named slot with a specific question gets written; an empty canvas does not. That is
 * the whole reason these are fixed slots rather than a block editor, so the questions
 * are the feature: each one asks about the thing its own section cannot say.
 */
export const PROMPTS = {
  page: 'What was this year about?',
  projects: 'What were you actually building?',
  highlights: 'Why these ones?',
  activity: 'What did the year feel like to work through?',
  hours: 'When do you actually work, and why?',
  'types:language': 'Why these languages?',
  'types:category': 'What kinds of things were they?',
  effort: 'Where did the effort really go?',
  compare: 'What changed since last time?',
};

/**
 * Soft caps. The counter appears past 80% of one and the text turns amber past it;
 * nothing truncates. A cap that enforces itself mid-sentence is a cap that loses the
 * sentence, and these are guidance about what reads well, not a storage limit.
 */
export const CAPS = { page: 400, section: 240 };
export const capFor = (slot) => (slot === 'page' ? CAPS.page : CAPS.section);

/**
 * Prose on the way in.
 *
 * v1 is plain text — no markdown, no HTML — and every renderer escapes it, so this is
 * not where injection is stopped. It is where a paste out of a word processor loses
 * what would otherwise render as garbage: CRLFs, control characters, and runs of blank
 * lines. Nothing is shortened here: the caps are soft, and silently eating the end of
 * a paste is worse than a long paragraph.
 */
export function sanitizeProse(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A section is stored as a run of blocks, not as a chart with a note attached.
 *
 * Today the only shapes are a chart and the prose that sits before it, which is exactly
 * what the fixed slots offer. Storing it as an ordered list anyway is what keeps a free
 * text block anywhere on the page a UI change later rather than a migration: both
 * renderers already walk the list in order and neither assumes chart order.
 */
const chartBlock = (chart) => ({ id: `chart:${chart}`, type: 'chart', chart });
// Stable once written, and only ever generated for a block someone actually typed into.
const textId = () => `t${Math.random().toString(36).slice(2, 8)}`;

/**
 * Where a chart the stored list never mentioned belongs: before the first chart that
 * comes after it — and before that chart's own prose, not between the two.
 *
 * Prose is positional: a text block belongs to the chart that follows it. So splicing a
 * new chart in directly ahead of a later chart drops it between that chart and its
 * intro, and the sentence silently changes owner. A version that learns about a new
 * chart must not be able to move someone's words onto it.
 */
function insertionPoint(blocks, chart) {
  const rank = CHART_ORDER.indexOf(chart);
  let at = blocks.findIndex((b) => b.type === 'chart' && CHART_ORDER.indexOf(b.chart) > rank);
  if (at < 0) return blocks.length;
  while (at > 0 && blocks[at - 1].type === 'text') at -= 1;
  return at;
}

/**
 * The stored list, made whole: every known chart present exactly once, in report order,
 * with whatever prose was stored around them kept where it was. A story written before
 * this existed has no list at all and gets the plain report; one written by a later
 * version that knows a chart this one doesn't simply drops it, which is the same thing
 * every other unknown field does here.
 */
export function normalizeBlocks(raw) {
  const out = [];
  const seen = new Set();
  for (const block of Array.isArray(raw) ? raw : []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      const body = sanitizeProse(block.body);
      if (body) out.push({ id: String(block.id || textId()), type: 'text', body });
    } else if (block.type === 'chart' && CHART_ORDER.includes(block.chart) && !seen.has(block.chart)) {
      seen.add(block.chart);
      out.push(chartBlock(block.chart));
    }
  }
  for (const chart of CHART_ORDER) {
    if (!seen.has(chart)) out.splice(insertionPoint(out, chart), 0, chartBlock(chart));
  }
  return out;
}

/** The prose immediately before a chart, which is where a section intro sits. */
export function introFor(story, chart) {
  const blocks = story.blocks || [];
  const at = blocks.findIndex((b) => b.type === 'chart' && b.chart === chart);
  const before = at > 0 ? blocks[at - 1] : null;
  return before?.type === 'text' ? before.body : '';
}

/** Write, replace, or — on empty text — remove that block. A cleared slot leaves nothing behind. */
export function setIntroFor(story, chart, body) {
  const blocks = story.blocks;
  const at = blocks.findIndex((b) => b.type === 'chart' && b.chart === chart);
  if (at < 0) return;
  const text = sanitizeProse(body);
  const before = at > 0 && blocks[at - 1].type === 'text' ? at - 1 : -1;
  if (!text) {
    if (before >= 0) blocks.splice(before, 1);
  } else if (before >= 0) {
    blocks[before].body = text;
  } else {
    blocks.splice(at, 0, { id: textId(), type: 'text', body: text });
  }
}

/**
 * The only markup prose carries: **bold**, *italic*, ***both***, and `code`.
 *
 * Restricted on purpose. Emphasis is what people actually reach for mid-sentence, and a
 * command or a flag is what a project description reaches for; each is something both
 * destinations can render, the page with real tags and the image with tspans. Headings,
 * lists and links are not here: a heading inside a slot competes with the section title
 * above it, and a link cannot be followed in a PNG.
 *
 * An emphasis delimiter only opens when a non-space follows it and only closes when a
 * non-space precedes it, so arithmetic and a lone asterisk stay literal. A code span is
 * literal inside, `*` and all, and never crosses a line. Anything unmatched is text.
 * Returns runs of {text, bold, italic, code}; every renderer walks the same list.
 */
export function parseInline(text) {
  const runs = [];
  const re = /`([^`\n]+)`|\*\*\*(?!\s)([\s\S]+?)(?<!\s)\*\*\*|\*\*(?!\s)([\s\S]+?)(?<!\s)\*\*|\*(?!\s)([\s\S]+?)(?<!\s)\*/g;
  let last = 0;
  let m = re.exec(text);
  while (m) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    if (m[1] !== undefined) runs.push({ text: m[1], code: true });
    else if (m[2] !== undefined) runs.push({ text: m[2], bold: true, italic: true });
    else if (m[3] !== undefined) runs.push({ text: m[3], bold: true });
    else runs.push({ text: m[4], italic: true });
    last = re.lastIndex;
    m = re.exec(text);
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.filter((r) => r.text);
}

export const pageIntro = (story) => story.intro || '';

export function setPageIntro(story, body) {
  const text = sanitizeProse(body);
  if (text) story.intro = text;
  else delete story.intro;
}

export const introOf = (story, slot) => (slot === 'page' ? pageIntro(story) : introFor(story, slot));
export const setIntro = (story, slot, body) =>
  (slot === 'page' ? setPageIntro(story, body) : setIntroFor(story, slot, body));

/**
 * The report as it will actually be laid out: the charts this data supports, in stored
 * order, each carrying the prose that sits before it.
 *
 * `present` is the set of charts worth drawing — a highlights card with nothing starred
 * is an empty box, not a section. Prose before a chart that isn't there goes with it: a
 * section that does not appear has no intro to introduce it, and the text is kept in the
 * story so it comes back when the section does.
 */
export function reportBlocks(story, present) {
  const blocks = story.blocks || normalizeBlocks([]);
  const out = [];
  let pending = '';
  for (const block of blocks) {
    if (block.type === 'text') {
      pending = block.body;
      continue;
    }
    // A chart inside a card is drawn by that card, along with its own prose; only the
    // cards themselves are laid down here.
    if (SECTION_ORDER.includes(block.chart) && present.has(block.chart)) {
      out.push({ chart: block.chart, intro: pending });
    }
    pending = '';
  }
  return out;
}

/* -------------------------------------------------------------------- units */

function sliceRepo(repo, { from, to }) {
  // repo.days maps a local day to [hour, added, removed] per commit; every other
  // number here is derived from that.
  const entries = {};
  const days = {};
  const lines = {};
  let commits = 0;
  let added = 0;
  let removed = 0;
  let firstDay = null;
  let lastDay = null;
  for (const [day, list] of Object.entries(repo.days)) {
    if (day < from || day > to) continue;
    entries[day] = list;
    days[day] = list.length;
    lines[day] = list.reduce((n, e) => n + e[1] + e[2], 0);
    commits += list.length;
    added += list.reduce((n, e) => n + e[1], 0);
    removed += list.reduce((n, e) => n + e[2], 0);
    if (!firstDay || day < firstDay) firstDay = day;
    if (!lastDay || day > lastDay) lastDay = day;
  }
  const releases = repo.releases
    .filter((r) => r.publishedAt.slice(0, 10) >= from && r.publishedAt.slice(0, 10) <= to)
    .map((r) => ({ ...r, repo: repo.name }));
  return {
    ...repo, entries, days, lines, commits, added, removed, linesChanged: added + removed,
    firstDay, lastDay, releases, createdDay: repo.createdAt.slice(0, 10),
  };
}

function toUnit(repos, { from, to }, group) {
  const byCommits = [...repos].sort((a, b) => b.commits - a.commits);
  const lead = byCommits[0];
  const entries = {};
  const days = {};
  const lines = {};
  for (const r of repos) {
    for (const [day, list] of Object.entries(r.entries)) (entries[day] ||= []).push(...list);
    for (const [day, count] of Object.entries(r.days)) days[day] = (days[day] || 0) + count;
    for (const [day, n] of Object.entries(r.lines)) lines[day] = (lines[day] || 0) + n;
  }
  const firsts = repos.map((r) => r.firstDay).filter(Boolean).sort();
  const lasts = repos.map((r) => r.lastDay).filter(Boolean).sort();
  const createdDay = repos.map((r) => r.createdDay).sort()[0];
  return {
    key: group ? group.id : lead.key,
    isGroup: Boolean(group),
    members: byCommits,
    name: group ? group.name : lead.name,
    fullName: group ? repos.map((r) => r.nameWithOwner).join(', ') : lead.nameWithOwner,
    isPrivate: repos.every((r) => r.isPrivate),
    isArchived: repos.every((r) => r.isArchived),
    // A merged project is polyglot: keep every language its repos use, busiest first,
    // instead of letting the largest repo speak for all of them.
    languages: (() => {
      const seen = new Map();
      for (const r of byCommits) {
        if (!r.language) continue;
        seen.set(r.language, (seen.get(r.language) || 0) + r.commits);
      }
      return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([name, commits]) => ({ name, commits }));
    })(),
    language: byCommits.find((r) => r.language)?.language || null,
    description: byCommits.find((r) => r.description)?.description || null,
    homepageUrl: byCommits.find((r) => r.homepageUrl)?.homepageUrl || null,
    stars: repos.reduce((n, r) => n + (r.stars || 0), 0),
    url: `https://github.com/${group ? repos[0].nameWithOwner : lead.nameWithOwner}`,
    entries,
    days,
    lines,
    commits: repos.reduce((n, r) => n + r.commits, 0),
    added: repos.reduce((n, r) => n + r.added, 0),
    removed: repos.reduce((n, r) => n + r.removed, 0),
    linesChanged: repos.reduce((n, r) => n + r.linesChanged, 0),
    firstDay: firsts[0] || null,
    lastDay: lasts[lasts.length - 1] || null,
    releases: repos.flatMap((r) => r.releases).sort((a, b) => (a.publishedAt < b.publishedAt ? -1 : 1)),
    createdDay,
    // A project is as old as its oldest repo.
    isNew: createdDay >= from && createdDay <= to,
  };
}

/** Every repo, with merged groups folded into one unit each, sliced to the period. */
export function buildUnits(data, story, period) {
  const repos = new Map(data.projects.map((r) => [r.key, sliceRepo(r, period)]));
  const claimed = new Set();
  const units = [];
  for (const group of story.groups) {
    const members = group.keys.map((k) => repos.get(k)).filter(Boolean);
    if (!members.length) continue;
    members.forEach((m) => claimed.add(m.key));
    units.push(toUnit(members, period, group));
  }
  for (const repo of repos.values()) {
    if (!claimed.has(repo.key)) units.push(toUnit([repo], period, null));
  }
  return units.sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
}

export const isActive = (u) => u.commits > 0 || u.releases.length > 0;
export const isIncluded = (u, story) => meta(story, u.key).include !== false;
export const resultFor = (u, story) => resultOf(meta(story, u.key).result);
export const unitName = (u, story) => (u.isGroup ? u.name : meta(story, u.key).name?.trim() || u.name);

/**
 * Names safe to share. Private repos you haven't renamed become "Private Rust project 2";
 * merged projects and renames are your own words, so they pass through.
 */
export function publicNames(units, story) {
  const names = new Map();
  const seen = new Map();
  const masked = [];
  for (const u of units) {
    const renamed = !u.isGroup && meta(story, u.key).name?.trim();
    if (u.isGroup || renamed || !u.isPrivate || story.options.realNames) {
      names.set(u.key, unitName(u, story));
      continue;
    }
    const base = u.language ? `Private ${u.language} project` : 'Private project';
    seen.set(base, (seen.get(base) || 0) + 1);
    masked.push([u.key, base, seen.get(base)]);
  }
  for (const [key, base, n] of masked) names.set(key, seen.get(base) > 1 ? `${base} ${n}` : base);
  return names;
}

/** Repos whose names share a leading token, e.g. widdl-macos + widdl-site. */
export function suggestGroups(units) {
  const buckets = new Map();
  for (const u of units) {
    if (u.isGroup) continue;
    const stem = u.name.toLowerCase().split(/[-_.]/)[0];
    if (stem.length < 3) continue;
    if (!buckets.has(stem)) buckets.set(stem, []);
    buckets.get(stem).push(u);
  }
  return [...buckets]
    .filter(([, us]) => us.length > 1)
    .map(([stem, us]) => ({ stem, units: us }))
    .sort((a, b) => b.units.length - a.units.length);
}

/* ------------------------------------------------------------------- totals */

export function periodStats(data, story, period) {
  const units = buildUnits(data, story, period).filter(isActive);
  const included = units.filter((u) => isIncluded(u, story));
  const perDay = { commits: {}, lines: {} };
  for (const u of included) {
    for (const [day, count] of Object.entries(u.days)) perDay.commits[day] = (perDay.commits[day] || 0) + count;
    for (const [day, n] of Object.entries(u.lines)) perDay.lines[day] = (perDay.lines[day] || 0) + n;
  }

  const series = {};
  let streak = 0;
  let best = 0;
  for (const metric of METRICS) {
    const calendar = [];
    const cumulative = [];
    let running = 0;
    for (let day = period.from; day <= period.to; day = addDays(day, 1)) {
      const count = perDay[metric.id][day] || 0;
      calendar.push({ date: day, count });
      running += count;
      cumulative.push(running);
      if (metric.id === 'commits') {
        // Streaks and active days count days you worked, whichever measure is on screen.
        streak = count ? streak + 1 : 0;
        best = Math.max(best, streak);
      }
    }
    series[metric.id] = { calendar, cumulative, total: running };
  }

  return {
    period,
    units,
    included,
    series,
    totals: {
      commits: series.commits.total,
      lines: series.lines.total,
      added: included.reduce((n, u) => n + u.added, 0),
      removed: included.reduce((n, u) => n + u.removed, 0),
      activeDays: series.commits.calendar.filter((c) => c.count).length,
      days: series.commits.calendar.length,
      projects: included.length,
      newProjects: included.filter((u) => u.isNew).length,
      releases: included.reduce((n, u) => n + u.releases.length, 0),
      streak: best,
    },
  };
}

export function dashboardModel(data, story) {
  const cov = coverage(data, story);
  return {
    viewer: data.viewer,
    timeZone: data.timeZone || 'local time',
    current: periodStats(data, story, cov.current),
    previous: cov.previous.map((p) => periodStats(data, story, p)),
  };
}

export function readyForDashboard(data, story) {
  if (!data) return false;
  const cov = coverage(data, story);
  if (!cov.ok) return false;
  return buildUnits(data, story, cov.current).some((u) => isActive(u) && isIncluded(u, story));
}

/** Rows for step 1: this period's projects, plus ones only active in the comparison periods. */
export function scopeModel(data, story) {
  const cov = coverage(data, story);
  const current = buildUnits(data, story, cov.current);
  const earlier = cov.previous.map((p) => new Map(buildUnits(data, story, p).map((u) => [u.key, u])));
  const rows = current.map((unit) => ({
    unit,
    prevCommits: earlier.length ? earlier[0].get(unit.key)?.commits || 0 : null,
    earlierCommits: earlier.reduce((n, m) => n + (m.get(unit.key)?.commits || 0), 0),
  }));
  return {
    coverage: cov,
    active: rows.filter((r) => isActive(r.unit)),
    earlierOnly: rows.filter((r) => !isActive(r.unit) && r.earlierCommits > 0),
  };
}

/**
 * The change from `prev` to `cur`, as { dir, text } — dir is 1, -1 or 0, and text is
 * the size of the change without its direction: "+27%", "−8%", "12x", "±0%".
 *
 * The text never says which way, because every caller draws an arrow beside it and
 * the arrow already does; "up" as well would be the same fact twice. Past roughly
 * tenfold, either way, the change is a multiple rather than a percentage: 3.95M against
 * 14,217 reads "+27,677%", which is arithmetic, not information.
 *
 * The edges: null when there is no earlier period at all, "no change" from 0 to 0, and
 * "from 0" when the earlier period had nothing — a percentage of zero is not a number.
 */
export function delta(cur, prev) {
  if (prev == null) return null;
  if (prev === 0) return cur === 0 ? { dir: 0, text: 'no change' } : { dir: 1, text: 'from 0' };
  const ratio = cur / prev;
  if (ratio >= 10) return { dir: 1, text: `${fmtNum(Math.round(ratio))}x` };
  if (ratio > 0 && ratio <= 0.1) return { dir: -1, text: `${fmtNum(Math.round(1 / ratio))}x` };
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return { dir: 0, text: '±0%' };
  return { dir: Math.sign(pct), text: `${pct > 0 ? '+' : '−'}${fmtNum(Math.abs(pct))}%` };
}
