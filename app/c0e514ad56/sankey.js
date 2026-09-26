import { MONTHS, RESULTS, UNSET, daysBetween, daysOf, esc, fmtNum, metricOf, parseKey, reasonOf, resultFor, totalOf } from './model.js';
import { INK3 } from './theme.js';
import { measure, svgText } from './svg.js';

// Neutrals for everything that is not a status. Label and value inks live in style.css.
const TIME_COLOR = '#3a3632';
// Darker than any status, so the combined node reads as a group, not an outcome.
const OTHER_COLOR = '#7a746c';
// "No result yet" is drawn hollow and hatched rather than in a fifth colour (see UNSET).
const HATCH = 's-hatch';
const HATCH_KEY = 's-hatch-key';
const hatchDef = (id) => `<pattern id="${id}" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">`
  + `<line x1="0" y1="0" x2="0" y2="4" stroke="${UNSET.color}" stroke-width="1.2"/></pattern>`;
// Past this many, the shades within one status stop being told apart.
const FAMILY_MAX = 6;
const NO_REASON = 'No reason given';

/** Per-channel RGB lerp from a to b by t. */
function mix(a, b, t) {
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [x, y] = [rgb(a), rgb(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * One member of a status family: the largest (k = 0) a little darker than the base, the
 * rest stepping lighter. Small families are padded to three so one or two projects never
 * reach the near-white end of the range.
 */
export function familyShade(base, k, count) {
  const n = Math.max(count, 3);
  const t = n === 1 ? 0.5 : k / (n - 1);
  return t < 0.5 ? mix(base, '#000000', (0.5 - t) * 0.45) : mix(base, '#ffffff', (t - 0.5) * 0.9);
}

/** Months for short periods, quarters otherwise, so the left column stays readable. */
function bucketer(period) {
  const monthly = daysBetween(period.from, period.to) <= 215;
  return {
    unit: monthly ? 'month' : 'quarter',
    of: (day) => {
      const d = parseKey(day);
      const y = d.getUTCFullYear();
      const m = d.getUTCMonth();
      if (monthly) return { id: `${y}-${String(m + 1).padStart(2, '0')}`, label: `${MONTHS[m]} ${y}` };
      const q = Math.floor(m / 3) + 1;
      return { id: `${y}-Q${q}`, label: `Q${q} ${y}` };
    },
  };
}

/**
 * Commits flow time -> project -> result -> why, as whole paths rather than per-column
 * links, so a project keeps one colour end to end. Projects past `maxProjects`, or past
 * FAMILY_MAX within their status, share one "smaller projects" node.
 */
export function sankeyData(stats, story, { maxProjects = 12, nameOf, metric = 'commits' }) {
  const buckets = bucketer(stats.period);
  const units = stats.included.filter((u) => totalOf(u, metric) > 0).sort((a, b) => totalOf(b, metric) - totalOf(a, metric));
  const rank = (id) => {
    const i = RESULTS.findIndex((r) => r.id === id);
    return i < 0 ? RESULTS.length : i;
  };

  // Rank within the family is commit order, the same order the project column uses.
  const family = new Map();
  const named = new Map();
  for (const u of units) {
    const res = resultFor(u, story);
    const k = family.get(res.id) || 0;
    if (named.size < maxProjects && k < FAMILY_MAX) {
      named.set(u.key, k);
      family.set(res.id, k + 1);
    }
  }
  const restCount = units.length - named.size;

  const nodes = new Map();
  const paths = new Map();
  const node = (id, col, label, color, order) => {
    if (!nodes.has(id)) nodes.set(id, { id, col, label, color, order, total: 0, hollow: color === UNSET.color });
    return id;
  };

  for (const u of units) {
    const res = resultFor(u, story);
    const k = named.get(u.key);
    const pid = k === undefined
      ? node('p:__other', 1, `${restCount} smaller projects`, OTHER_COLOR, [RESULTS.length + 1, 0])
      : node(`p:${u.key}`, 1, nameOf(u), res.hollow ? res.color : familyShade(res.color, k, family.get(res.id)), [rank(res.id), -totalOf(u, metric)]);
    const rid = node(`r:${res.id}`, 2, res.label, res.color, [rank(res.id), 0]);
    const why = reasonOf(u, story) || NO_REASON;
    const wid = node(`w:${res.id}:${why.toLowerCase()}`, 3, why, res.color, [rank(res.id), 0]);
    nodes.get(wid).total += totalOf(u, metric);
    nodes.get(wid).status = res;

    for (const [day, count] of Object.entries(daysOf(u, metric))) {
      const b = buckets.of(day);
      const tid = node(`t:${b.id}`, 0, b.label, TIME_COLOR, [b.id, 0]);
      const key = `${tid}|${pid}|${rid}|${wid}`;
      if (!paths.has(key)) paths.set(key, { ids: [tid, pid, rid, wid], value: 0, color: nodes.get(pid).color, hatch: !!res.hollow });
      paths.get(key).value += count;
    }
  }

  // Reasons sit largest first under their outcome, with the unexplained last. Only now
  // are their totals known.
  const reasons = [...nodes.values()].filter((n) => n.col === 3);
  for (const n of reasons) n.order[1] = n.label === NO_REASON ? Number.MAX_SAFE_INTEGER : -n.total;

  // The smaller-projects node spans several statuses, so it has no shade of its own; its
  // ribbons take one from their reason's rank within that status instead.
  for (const p of paths.values()) {
    if (p.ids[1] !== 'p:__other') continue;
    const w = nodes.get(p.ids[3]);
    if (w.status.hollow) continue;
    const siblings = reasons.filter((n) => n.status.id === w.status.id).sort((a, b) => a.order[1] - b.order[1]);
    p.color = familyShade(w.status.color, siblings.indexOf(w), siblings.length + 1);
  }

  const out = [...nodes.values()].map(({ total, status, ...n }) => n);
  const unset = units.some((u) => resultFor(u, story).hollow);
  return { nodes: out, paths: [...paths.values()], unit: buckets.unit, restCount, unset, noun: metricOf(metric).noun };
}

/** Every node with its total, grouped into columns in display order. */
function columnsOf(sd) {
  const byId = new Map(sd.nodes.map((n) => [n.id, { ...n, value: 0 }]));
  for (const p of sd.paths) for (const id of p.ids) byId.get(id).value += p.value;
  const cols = Array.from({ length: Math.max(...sd.nodes.map((n) => n.col)) + 1 }, () => []);
  for (const n of byId.values()) cols[n.col].push(n);
  const cmp = (a, b) => (a.order[0] < b.order[0] ? -1 : a.order[0] > b.order[0] ? 1 : a.order[1] - b.order[1]);
  cols.forEach((c) => c.sort(cmp));
  return { byId, cols };
}

/**
 * How tall a column stands at scale k (px per commit). Neighbours keep `gap` of air
 * between them and their centres at least `labelGap` apart, so labels never overlap:
 * the node spacing gives way rather than the text.
 */
function columnSpacing({ gap, labelGap, nodeMin }) {
  const height = (n, k) => Math.max(nodeMin, n.value * k);
  const between = (a, b, k) => Math.max(gap, labelGap - (height(a, k) + height(b, k)) / 2);
  const used = (col, k) => col.reduce((s, n, i) => s + height(n, k) + (i ? between(col[i - 1], n, k) : 0), 0);
  return { height, between, used };
}

/**
 * One scale for every column, so a band is the same width at both ends: the largest
 * that lets every column fit in `avail`. used() only grows with k, so a bisection finds it.
 */
function fitScale(cols, used, avail) {
  let lo = 0;
  let hi = avail / Math.max(...cols.map((c) => c.reduce((s, n) => s + n.value, 0)));
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (cols.every((c) => used(c, mid) <= avail)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Gives each node its x, y and height: columns spread across, each centred vertically. */
function placeNodes(cols, spacing, k, { x0, x1, top, avail }) {
  cols.forEach((col, ci) => {
    const x = Math.round(x0 + (cols.length > 1 ? (ci * (x1 - x0)) / (cols.length - 1) : 0));
    let y = top + (avail - spacing.used(col, k)) / 2;
    col.forEach((n, i) => {
      if (i) y += spacing.between(col[i - 1], n, k);
      Object.assign(n, { x, y, h: spacing.height(n, k) });
      y += n.h;
    });
  });
}

/** Columns to break ties on for the gap after column c: further along first, then back. */
function tieBreak(c, last) {
  const ahead = Array.from({ length: last - c - 1 }, (_, i) => c + 2 + i);
  const behind = Array.from({ length: c }, (_, i) => c - 1 - i);
  return [...ahead, ...behind];
}

/** Ribbons ordered by the height of the nodes they pass through in `cols`, in turn. */
function byNodeHeight(ribbons, cols) {
  return [...ribbons].sort((a, b) => {
    for (const c of cols) {
      const d = a.nodes[c].y - b.nodes[c].y;
      if (d) return d;
    }
    return 0;
  });
}

/** Lays `ribbons` down the node from its top, writing each one's offset into `side[ci]`. */
function stack(n, ribbons, ci, side) {
  let y = n.y;
  for (const r of ribbons) {
    r[side][ci] = y;
    y += r.w;
  }
}

/**
 * Where each ribbon leaves and enters every node, to keep crossings down. Ribbons
 * leaving column c are ordered by where they arrive, and ribbons arriving by where they
 * left. Both ends of a gap share one tie-break, so ribbons between the same two nodes
 * never cross each other.
 */
function stackRibbons(cols, ribbons) {
  const last = cols.length - 1;
  cols.forEach((col, ci) => {
    for (const n of col) {
      const through = ribbons.filter((r) => r.nodes[ci] === n);
      if (ci < last) stack(n, byNodeHeight(through, [ci + 1, ...tieBreak(ci, last)]), ci, 'outs');
      if (ci > 0) stack(n, byNodeHeight(through, [ci - 1, ...tieBreak(ci - 1, last)]), ci, 'ins');
    }
  });
}

/** Quarters label to the left; everything else to the right, outcomes and reasons with totals. */
function labelFor(n, nodeW, last) {
  const y = n.y + n.h / 2 + 4;
  if (n.col === 0) return { text: n.label, x: n.x - 8, y, anchor: 'end', kind: 'time' };
  const x = n.x + nodeW + 6;
  if (n.col === last) return { text: n.label, value: fmtNum(n.value), x, y, anchor: 'start', kind: 'reason' };
  if (n.col === 2) return { text: n.label, value: fmtNum(n.value), x, y: y + 0.5, anchor: 'start', kind: 'result' };
  return { text: n.label, x, y, anchor: 'start', kind: 'project' };
}

export function layoutSankey(sd, o = {}) {
  const {
    W = 1120, H: minH = 460, nodeW = 8, gap = 12, labelGap = 17, nodeMin = 2,
    padL = 74, padR = 236, padT = 8, padB = 8,
  } = o;
  if (!sd.paths.length) return { W, H: minH, nodeW, nodes: [], ribbons: [], labels: [] };

  const { byId, cols } = columnsOf(sd);
  const spacing = columnSpacing({ gap, labelGap, nodeMin });
  // A crowded column grows the chart rather than squeezing the bands to nothing.
  const crowd = Math.max(...cols.map((c) => spacing.used(c, 0)));
  const H = Math.max(minH, Math.ceil(padT + padB + crowd + 0.4 * (minH - padT - padB)));
  const avail = H - padT - padB;
  const k = fitScale(cols, spacing.used, avail);
  placeNodes(cols, spacing, k, { x0: padL, x1: W - padR - nodeW, top: padT, avail });

  const ribbons = sd.paths.map((p) => ({
    ...p, nodes: p.ids.map((id) => byId.get(id)), w: p.value * k, ins: [], outs: [],
  }));
  stackRibbons(cols, ribbons);

  const nodes = [...byId.values()];
  const labels = nodes.map((n) => labelFor(n, nodeW, cols.length - 1));
  return { W, H, nodeW, nodes, ribbons, labels, noun: sd.noun, unset: sd.unset };
}

/**
 * One path through all three gaps. Inside a node the edge steps from where the ribbon
 * came in to where it leaves; the node is drawn over that step.
 */
function ribbonPath(rb, nodeW) {
  const r = (v) => v.toFixed(1);
  const w = Math.max(rb.w, 0.75);
  const n = rb.nodes;
  let top = `M${r(n[0].x + nodeW)},${r(rb.outs[0])}`;
  let bottom = '';
  for (let c = 0; c < n.length - 1; c += 1) {
    const x0 = n[c].x + nodeW;
    const x1 = n[c + 1].x;
    const xm = (x0 + x1) / 2;
    const [sy, ty] = [rb.outs[c], rb.ins[c + 1]];
    top += `C${r(xm)},${r(sy)} ${r(xm)},${r(ty)} ${r(x1)},${r(ty)}`;
    if (c + 1 < n.length - 1) top += `L${r(x1 + nodeW)},${r(rb.outs[c + 1])}`;
    let seg = `C${r(xm)},${r(ty + w)} ${r(xm)},${r(sy + w)} ${r(x0)},${r(sy + w)}`;
    if (c > 0) seg += `L${r(n[c].x)},${r(rb.ins[c] + w)}`;
    bottom = seg + bottom;
  }
  const end = n[n.length - 1].x;
  return `${top}L${r(end)},${r(rb.ins[n.length - 1] + w)}${bottom}Z`;
}

export function sankeySVG(L) {
  const r = (v) => v.toFixed(1);
  const ribbons = L.ribbons.map((rb) => {
    const tip = `${rb.nodes.map((n) => n.label).join(' → ')}: ${fmtNum(rb.value)} ${L.noun}`;
    const paint = rb.hatch ? `class="s-link hatch" fill="url(#${HATCH})"` : `class="s-link" fill="${rb.color}"`;
    return `<path ${paint} d="${ribbonPath(rb, L.nodeW)}" data-nodes="${esc(rb.ids.join('|'))}" data-tip="${esc(tip)}"/>`;
  }).join('');
  const nodes = L.nodes.map((n) =>
    `<rect class="s-node" x="${n.x}" y="${r(n.y)}" width="${L.nodeW}" height="${r(n.h)}" rx="2" ${n.hollow
      ? `fill="#ffffff" stroke="${n.color}" stroke-width="1"` : `fill="${n.color}"`} data-node="${esc(n.id)}" data-tip="${esc(`${n.label} · ${fmtNum(n.value)} ${L.noun}`)}"/>`).join('');
  const labels = L.labels.map((lab) =>
    `<text class="s-label ${lab.kind}" x="${r(lab.x)}" y="${r(lab.y)}" text-anchor="${lab.anchor}">${esc(lab.text)}${lab.value ? `<tspan class="s-value" dx="6">${lab.value}</tspan>` : ''}</text>`).join('');
  return `<svg class="sankey" viewBox="0 0 ${L.W} ${L.H}" role="img" aria-label="Commits by time, project and result">${L.unset ? `<defs>${hatchDef(HATCH)}</defs>` : ''}${ribbons}${nodes}${labels}</svg>`;
}

/** The four statuses, and No result yet when the chart has any, for under it on the page. */
export const statusLegend = (L) => `<div class="legend">${RESULTS.map((s) =>
  `<span class="lg"><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}
  ${L.unset ? `<span class="lg"><i class="hatch"></i>${esc(UNSET.label)}</span>` : ''}</div>`;

/** The same key as SVG, for the exported image. */
export function statusLegendSVG(L, { y = 0, size = 12 } = {}) {
  let cx = 0;
  const keys = L.unset ? [...RESULTS, UNSET] : RESULTS;
  const out = keys.map((s) => {
    const chip = s.hollow
      ? `<defs>${hatchDef(HATCH_KEY)}</defs><rect x="${cx + 0.5}" y="${y + 0.5}" width="11" height="11" rx="2.5" fill="url(#${HATCH_KEY})" stroke="${s.color}" stroke-width="1"/>`
      : `<rect x="${cx}" y="${y}" width="12" height="12" rx="2.5" fill="${s.color}"/>`;
    const text = svgText(s.label, cx + 17, y + 10, { size, fill: INK3 });
    cx += 17 + measure(s.label, 400, size) + 14;
    return chip + text;
  }).join('');
  return { markup: out, height: 18 };
}
