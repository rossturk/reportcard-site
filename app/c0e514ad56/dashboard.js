import { hideTip, save, showTip, state, toast } from './store.js';
import {
  KPIS, METRICS, PROMPTS, addDays, categoryOf, dashboardModel, delta, descriptionOf, esc, fmtBig, fmtTight,
  fmtDay, fmtNum, fmtRange, isHighlighted, meta, metricFor, metricOf, reportBlocks, resultFor, setMetric,
  unitName,
} from './model.js';
import { RAMP, heatmapSVG, layoutHeatmap, monthBlocksHTML } from './heatmap.js';
import {
  GANTT_KEY, ganttMonthsSVG, ganttPortraitSVG, ganttRows, ganttSVG, layoutGantt, layoutGanttPortrait,
} from './gantt.js';
import { layoutSankey, sankeyData, sankeySVG, statusLegend } from './sankey.js';
import { compareSeries, compareSVG, layoutCompare } from './compare.js';
import {
  clockModel, dialSVG, fmtHour, layoutDial, layoutMatrix, layoutMatrixPortrait, matrixPortraitSVG,
  matrixSVG, scheduleFacts,
} from './clock.js';
import { BAR_FILL, barsSVG, breakdownData, layoutBars } from './breakdown.js';
import { highlightsSVG } from './highlights.js';
import { imageSources } from './svg.js';
import { FONT } from './theme.js';
import { SECTIONS, TIMELINE_CHOICES, renderPng, renderShare } from './export.js';
import { draftsFor, proseSlot, wireProse } from './prose.js';

const arrow = (d) => (d.dir > 0 ? '▲' : d.dir < 0 ? '▼' : '■');

/** A section's own Commits/Lines switch, rendered into its heading. */
const metricToggle = (section, chosen) => `<div class="seg xs" role="group" aria-label="Measure">
    ${METRICS.map((m) => `<button type="button" data-section="${section}" data-metric="${m.id}"
      aria-pressed="${chosen === m.id}">${m.label}</button>`).join('')}</div>`;

const card = (title, sub, body, foot = '', control = '') => `<section class="card">
    <div class="card-head"><h2>${title}</h2>${sub ? `<span class="muted">${sub}</span>` : ''}${control}</div>
    ${body}
    ${foot ? `<p class="card-foot">${foot}</p>` : ''}
  </section>`;

/**
 * The measure pass: the model, and every layout that the markup and the wiring both
 * read.
 *
 * Same split as the exported image, for the same reason. Rendering a dashboard is two
 * jobs — working out how big everything is, and deciding where it goes — and they were
 * interleaved down three hundred lines, so neither could be read without the other.
 */
function dashboardView() {
  const model = dashboardModel(state.data, state.story);
  const cur = model.current;
  const prev = model.previous[0] || null;
  const nameOf = (u) => unitName(u, state.story);
  const resultOf = (u) => resultFor(u, state.story);
  // Each of these sections carries its own measure; the rest still read the stored
  // default, which is also what seeds a section the first time it is shown.
  const mActivity = metricFor(state.story, 'activity');
  const metric = metricOf(state.story.options.metric).id;
  const noun = metricOf(metric).noun;

  const series = model.previous.length ? compareSeries(model, metric) : null;
  const cmp = series ? layoutCompare(series, { W: 1120, H: 290 }) : null;
  const gantt = layoutGantt(cur.period, ganttRows(cur.included, Infinity, metric), { W: 1120, metric });
  const clock = clockModel(cur, metric);
  const dial = layoutDial(clock, { size: 280 });
  const matrix = layoutMatrix(clock, { W: 760 });
  const sd = sankeyData(cur, state.story, { maxProjects: 12, nameOf, metric });
  const sk = layoutSankey(sd, { W: 1120, H: Math.max(380, Math.min(620, 150 + 30 * sd.nodes.filter((n) => n.col === 1).length)) });

  const ganttTrimmed = ganttRows(cur.included, Infinity, metric).length;

  const highlights = cur.included.filter((u) => isHighlighted(u, state.story))
    .sort((a, b) => b.commits - a.commits);
  // Outcome already has the sankey's third column; repeating it here earned nothing.
  const breakdowns = [
    { id: 'language', title: 'Lines of code by language', dimension: 'language' },
    { id: 'category', title: 'Projects by category', dimension: 'category' },
  ].map((b) => ({ ...b, data: breakdownData(cur.included, state.story, b.dimension, 'lines') }));
  const uncategorized = cur.included.filter((u) => !categoryOf(u, state.story)).length;

  // Which sections this report actually has. A highlights card with nothing starred is
  // an empty box, not a section — and a section that isn't drawn takes its intro with it.
  const present = new Set(['projects', 'activity', 'types']);
  if (highlights.length) present.add('highlights');
  if (clock.total) present.add('hours');
  if (sk.ribbons.length) present.add('effort');
  if (cmp) present.add('compare');

  return {
    model, cur, prev, nameOf, resultOf, mActivity, metric, noun,
    series, cmp, gantt, clock, dial, matrix, sd, sk,
    ganttTrimmed, highlights, breakdowns, uncategorized,
    story: state.story, present,
  };
}

/** The whole page, as one string. Nothing here measures and nothing here listens. */
function dashboardMarkup(v) {
  const {
    model, cur, prev, nameOf, resultOf, mActivity, metric, noun,
    series, cmp, gantt, clock, dial, matrix, sd, sk,
    ganttTrimmed, highlights, breakdowns, uncategorized, story, present,
  } = v;
  // Prompts and drafts belong to the person editing the report, not to a reader of it.
  const owner = !state.static;
  // A card whose charts carry their own prose has no slot of its own, and asks for none.
  const slot = (id) => (PROMPTS[id] ? proseSlot(id, story, { owner, draft: v.drafts[id] }) : '');

  const kpi = (k) => {
    const value = cur.totals[k.key];
    const d = prev && delta(value, prev.totals[k.key]);
    const foot = d
      ? `<span class="kpi-delta">${arrow(d)} ${d.text} <span>vs ${fmtTight(prev.totals[k.key])}</span></span>`
      : '';
    return `<div class="kpi">
      <span class="kpi-label">${k.label}</span>
      <b class="kpi-value">${fmtBig(value)}${k.unit ? `<small>${k.unit}</small>` : ''}</b>
      ${foot}
    </div>`;
  };

  const compareTable = () => `<div class="scroll-x"><table class="cmp-table">
    <thead><tr>
      <th></th>
      ${series.map((s) => `<th><span class="sw${s.dash.length ? ' dash' : ''}" style="--c:${s.color}"></span>${s.label}<small>${s.range}</small></th>`).join('')}
      <th>Change</th>
    </tr></thead>
    <tbody>${KPIS.map((k) => `<tr>
      <th>${k.label}</th>
      ${series.map((s) => `<td>${fmtNum(s.stats.totals[k.key])}</td>`).join('')}
      <td class="chg">${(() => { const d = delta(cur.totals[k.key], prev.totals[k.key]); return `${arrow(d)} ${d.text}`; })()}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;

  const highlightCard = (intro) => card('Project highlights', '',
    `${intro}<div class="highlights-host"></div>`, '',
    `<span class="head-legend">${highlights.length} chosen</span>`);

  const typesCard = () => card('Project types', '',
    `<div class="breakdowns">${breakdowns.map((b) => `<figure class="breakdown">
      <figcaption>${b.title}</figcaption>
      ${slot(`types:${b.id}`)}
      <div class="bars-host" data-dim="${b.id}"></div>
    </figure>`).join('')}</div>`,
    // The titles say what each bar measures, so the only thing left worth a footnote is
    // the gap in the data.
    uncategorized
      ? `${uncategorized} ${uncategorized === 1 ? 'project has' : 'projects have'} no category yet — set one in Scope, under a project's ▾.`
      : '');

  /*
   * Whose report this is comes first on the published site — it is someone's own page,
   * not step 2 of an app, so it opens the way the exported image does and has nothing
   * to click. In the workspace the title is the period, because the person reading it
   * is the person whose report it is and already knows.
   */
  const head = state.static
    ? `<div>
        <h1>Report Card: <span class="handle">@${esc(model.viewer.login)}</span></h1>
        <p class="site-range">${fmtRange(cur.period.from, cur.period.to)}${prev
          ? ` <span>· vs ${fmtRange(prev.period.from, prev.period.to)}</span>` : ''}</p>
      </div>`
    : `<div>
        <div class="eyebrow">Step 2 of 2&ensp;·&ensp;${esc(model.viewer.name || model.viewer.login)}</div>
        <h1>${fmtRange(cur.period.from, cur.period.to)}</h1>
        <p class="lede">${cur.totals.projects} projects${prev
          ? `&ensp;·&ensp;compared with ${fmtRange(prev.period.from, prev.period.to)}` : ''}</p>
      </div>
      <div class="actions">
        <button type="button" class="btn" data-act="back">← Edit scope</button>
        <button type="button" class="btn primary" data-act="export">Export image</button>
      </div>`;

  /**
   * One card per chart, each taking the prose that sits above it. The order is not here:
   * the report is a list of blocks and the walk below lays them down in the order they
   * are stored, which is what makes a text block anywhere on the page a change to this
   * map rather than a change to the page.
   */
  const cards = {
    projects: (intro) => card('Projects over time', '',
      `${intro}<div class="gantt-host"></div>
        <div class="legend" id="gantt-legend"></div>`),

    highlights: highlightCard,

    activity: (intro) => card('Activity', '', `${intro}
        <div class="scroll-x" id="heat"></div>
        <div class="legend" id="heat-legend"></div>`, '', metricToggle('activity', mActivity)),

    hours: (intro) => card('Working hours', '', `${intro}
        <div class="clock-grid">
          <div class="dial-wrap">
            ${dialSVG(dial, clock)}
            <p class="dial-cap">
              <span><i class="thin"></i>Working window</span>
              <span><i class="thick"></i>Busiest</span>
            </p>
          </div>
          <div class="matrix-wrap"></div>
        </div>
        <div class="facts">${scheduleFacts(clock).map((f) => `<div class="fact">
          <span>${f.label}</span><b>${esc(f.value)}</b><small>${esc(f.note)}</small>
        </div>`).join('')}</div>`),

    types: typesCard,

    // The sankey names every column it draws and labels the combined flow "23 smaller
    // projects" itself. The one thing it can't say is which colour is which status.
    effort: (intro) => card('Where the effort went', '',
      `${intro}<div class="scroll-x">${sankeySVG(sk)}</div>${statusLegend(sk)}`),

    compare: (intro) => card('Compared with earlier periods', '', `${intro}
        <div class="scroll-x" id="cmp" data-tip-custom>${compareSVG(cmp)}</div>
        ${compareTable()}`, '',
      `<span class="head-legend">Cumulative ${noun}, aligned by day of period; month labels are this period’s</span>`),
  };

  return `<div class="dash">
    <div class="page">
      <header class="dash-head">${head}</header>
      ${slot('page')}
      <div class="kpis">${KPIS.map(kpi).join('')}</div>

      ${reportBlocks(story, present).map(({ chart }) => cards[chart](slot(chart))).join('\n')}
    </div>

    ${state.static ? '' : `<div class="modal" id="modal" hidden>
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-head">
          <h3 id="modal-title">Export image</h3>
          <label class="check"><input type="checkbox" id="real-names" ${state.story.options.realNames ? 'checked' : ''}> Show private repo names</label>
          <button type="button" class="btn ghost" data-act="close">Close</button>
        </div>
        <div class="modal-sections">
          <span class="label">Sections</span>
          ${SECTIONS.filter((s) => (s.id === 'compare' ? Boolean(cmp) : s.id === 'hours' ? clock.total > 0 : true))
            .map((s) => `<label class="check"><input type="checkbox" data-section="${s.id}" checked> ${s.label}</label>`).join('')}
          <label class="sort">Timeline
            <select class="plain" id="timeline-rows">
              ${TIMELINE_CHOICES.map((c) => `<option value="${c.id}">${c.label}${c.id === 'all' ? ` (${ganttTrimmed})` : ''}</option>`).join('')}
            </select>
          </label>
        </div>
        <div class="modal-body"><canvas id="png"></canvas></div>
        <div class="modal-foot">
          <span class="muted" id="png-meta">Rendering…</span>
          <button type="button" class="btn primary" data-act="download">Download PNG</button>
        </div>
      </div>
    </div>`}
  </div>`;
}

let currentRedraw = null;
let resizeWired = false;

/**
 * Every chart whose shape depends on the width of the box it lands in: the type bars,
 * the highlights, and the three that switch to a portrait layout on a narrow screen —
 * the timeline, the calendar and the weekday grid. They cannot be drawn with the rest
 * of the markup, because the box has to exist before it can be measured, and they are
 * drawn again whenever the window changes size.
 */
function drawFitted(dash, v) {
  const { highlights, breakdowns } = v;
  // The bars need a real width before they can be laid out — the name column and the
  // track are measured against it, and both change when the window does.
  const drawBars = () => {
    for (const host of dash.querySelectorAll('.bars-host')) {
      const chart = breakdowns.find((b) => b.id === host.dataset.dim);
      if (!chart) continue;
      const width = Math.max(240, host.clientWidth);
      const L = layoutBars(chart.data, { width, noun: chart.data.noun, fill: BAR_FILL });
      host.innerHTML = `<svg width="${width}" height="${L.height}" viewBox="0 0 ${width} ${L.height}">`
        + `${barsSVG(L)}</svg>`;
    }
  };
  // Screenshots are decoded once for their true dimensions; the page keeps plain URLs,
  // the export swaps in data URIs. Same renderer either way.
  const drawHighlights = async () => {
    const host = dash.querySelector('.highlights-host');
    if (!host || !highlights.length) return;
    const sources = await imageSources(highlights.map((u) => meta(state.story, u.key).image), { inline: false });
    const width = Math.max(280, host.clientWidth);
    const { markup, height } = highlightsSVG(highlights, state.story, { width, sources });
    host.innerHTML = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${markup}</svg>`;
  };

  /**
   * The timeline, in whichever shape the width allows.
   *
   * Under about 660px the desktop chart is wider than its own card and panning it
   * leaves the project names behind, so the portrait layout takes over: the name sits
   * above its bar and the year fills the card. The month scale is a separate element
   * in that mode because the page pins it — nothing inside one SVG can stay put while
   * the rest of it scrolls.
   */
  const drawGantt = () => {
    const host = dash.querySelector('.gantt-host');
    if (!host) return;
    const width = Math.max(240, host.clientWidth);
    const rows = ganttRows(v.cur.included, Infinity, v.metric);
    if (width < 660) {
      const L = layoutGanttPortrait(v.cur.period, rows, { W: width, metric: v.metric });
      host.innerHTML = `<div class="gantt-axis-wrap">${ganttMonthsSVG(L)}</div>`
        + ganttPortraitSVG(L, { nameOf: v.nameOf, resultOf: v.resultOf });
      legend(L.cuts);
    } else {
      host.innerHTML = `<div class="scroll-x">${ganttSVG(v.gantt, { nameOf: v.nameOf, resultOf: v.resultOf })}</div>`;
      legend(v.gantt.cuts);
    }
    wireScrollers(dash);
  };
  const legend = (cuts) => {
    const el = dash.querySelector('#gantt-legend');
    if (el) el.innerHTML = rampLegend(cuts, v.noun, { zero: null, unit: 'in a week', tail: GANTT_KEY });
  };

  /**
   * The weekday grid, whichever way round fits.
   *
   * 24 hours across wants 700px before the cells stop being slivers. Under that the
   * grid is turned: the week becomes seven columns, which is the one thing a phone is
   * certainly wide enough for, and the day runs down the page.
   */
  const drawMatrix = () => {
    const host = dash.querySelector('.matrix-wrap');
    if (!host || !v.clock.total) return;
    const width = Math.max(240, host.clientWidth);
    host.innerHTML = width < 560
      ? matrixPortraitSVG(layoutMatrixPortrait(v.clock, { W: width }), v.clock)
      : matrixSVG(v.matrix, v.clock);
  };

  const redraw = () => { drawBars(); drawHighlights(); drawGantt(); drawHeatmap(dash, v); drawMatrix(); };
  redraw();
  // One listener for the life of the page, pointed at whichever dashboard is current.
  // Adding one per render stacked them: every metric switch and every filled slot left
  // another handler behind, still redrawing charts into nodes no longer on the page.
  currentRedraw = redraw;
  if (!resizeWired) {
    resizeWired = true;
    addEventListener('resize', () => currentRedraw?.(), { passive: true });
    // These charts measure their text to lay it out: the bars size their name column
    // to the longest name, the highlights wrap their lines. Drawn before the page face
    // arrives, they measure a narrower fallback, and the real text then overflows,
    // clipping "Market Research" at the card's edge. So they draw again once it is in.
    // Asked for by name: fonts.ready can settle before a face nobody has used yet has
    // even started loading.
    Promise.all([400, 700].map((w) => document.fonts?.load(`${w} 13px ${FONT}`)))
      .then(() => currentRedraw?.(), () => {});
  }
}

/** The charts that answer the pointer. */
function wireCharts(dash, v) {
  const { cmp, series, cur } = v;
  if (cmp) wireCompare(dash, cmp, series, cur);
  wireSankey(dash);
  wireScrollers(dash);
}

/**
 * A chart that scrolls, and the fade that admits it.
 *
 * Several charts are wider than a phone and sit in their own scroller. Nothing said so:
 * the content simply stopped at the edge, which reads as the end of the chart rather
 * than the edge of the window. Each side gets a fade only while there is something that
 * way, so the affordance disappears the moment it would be a lie.
 */
function wireScrollers(dash) {
  for (const box of dash.querySelectorAll('.scroll-x')) {
    // A redraw replaces a scroller's contents, so this runs again; listeners are added
    // to each box once.
    if (box.dataset.scrollWired) continue;
    box.dataset.scrollWired = '1';
    const mark = () => {
      const max = box.scrollWidth - box.clientWidth;
      box.classList.toggle('more-left', box.scrollLeft > 2);
      box.classList.toggle('more-right', box.scrollLeft < max - 2);
    };
    box.addEventListener('scroll', mark, { passive: true });
    addEventListener('resize', mark, { passive: true });
    mark();
  }
}

/**
 * Everything clickable: the per-section measure switches, the export modal and the
 * download it ends in. On the published site the modal is not in the markup at all, so
 * every handle into it is optional rather than guarded one by one.
 */
function wireActions(dash, v, go) {
  const { model, cur, metric } = v;
  const modal = dash.querySelector('#modal');
  const chosen = () => new Set([...dash.querySelectorAll('[data-section]')].filter((c) => c.checked).map((c) => c.dataset.section));
  const paint = async () => {
    const meta = dash.querySelector('#png-meta');
    meta.textContent = 'Rendering…';
    const info = await renderPng(model, state.story, dash.querySelector('#png'), chosen(), dash.querySelector('#timeline-rows').value, metric);
    const trimmed = info.rows < info.totalRows ? `&ensp;·&ensp;timeline shows top ${info.rows} of ${info.totalRows}` : '';
    meta.innerHTML = `${info.width} × ${info.height}px${trimmed}`
      + (info.fits ? '&ensp;·&ensp;<b>fits LinkedIn 4:5</b>' : '&ensp;·&ensp;<b class="over">taller than LinkedIn 4:5 — feed will crop it</b>');
  };
  const close = () => { if (modal) modal.hidden = true; };

  dash.addEventListener('click', async (e) => {
    const pick = e.target.closest('[data-metric]');
    if (pick) {
      setMetric(state.story, pick.dataset.section, pick.dataset.metric);
      save();
      // Only the calendar reads this measure, so only the calendar is redrawn. This
      // used to re-render the whole page, and because several charts are drawn into
      // empty hosts once the page can be measured, the page was briefly a thousand
      // pixels shorter than where you were reading — the browser clamped the scroll,
      // and every click on this switch threw you up the page.
      v.mActivity = metricFor(state.story, 'activity');
      for (const b of pick.parentElement.querySelectorAll('[data-metric]')) {
        b.setAttribute('aria-pressed', String(b === pick));
      }
      drawHeatmap(dash, v);
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'back') go('scope');
    if (act === 'export' && modal) {
      modal.hidden = false;
      paint();
    }
    if (act === 'close' || e.target === modal) close();
    if (act === 'download') {
      dash.querySelector('#png').toBlob((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `report-card-${model.viewer.login}-${cur.period.from}-${cur.period.to}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        toast('Image saved');
      }, 'image/png');
    }
  });
  for (const box of dash.querySelectorAll('[data-section]')) box.addEventListener('change', paint);
  dash.querySelector('#timeline-rows')?.addEventListener('change', paint);
  dash.querySelector('#real-names')?.addEventListener('change', (e) => {
    state.story.options.realNames = e.target.checked;
    save();
    paint();
  });
  dash.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal && !modal.hidden) close(); });
}

/**
 * The image a shared link unfurls with.
 *
 * It is the top of the exported image, cropped to the 1200x630 every unfurler wants —
 * the same header, intro and totals, so the card that appears in a chat is the report's
 * own first screen rather than a generic blurb. A static site cannot draw one, so the
 * workspace does it and `reportcard export` copies whatever it finds.
 *
 * Painted once when the dashboard opens and again after the report's opening lines
 * change, debounced the way the story's own save is: the alternative is a card that
 * shows the report as it was when you last reloaded, which is exactly wrong on the day
 * you write the intro and publish.
 */
let shareTimer = null;
function paintShareImage(view) {
  if (state.static) return;
  clearTimeout(shareTimer);
  shareTimer = setTimeout(async () => {
    try {
      const canvas = document.createElement('canvas');
      await renderShare(view.model, state.story, canvas, view.metric);
      const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'));
      if (!blob) return;
      await fetch('/api/share', { method: 'PUT', headers: { 'content-type': 'image/png' }, body: blob });
    } catch (e) {
      // A missing share image costs the unfurl its picture, not the dashboard.
      console.warn('share image:', e);
    }
  }, 1500);
}

export function renderDashboard(root, go) {
  const view = dashboardView();
  // Written once and read twice: the markup puts a draft in each empty slot, and the
  // editor hands back the same sentence when one is accepted.
  view.drafts = state.static ? {} : draftsFor(view);
  root.innerHTML = dashboardMarkup(view);

  const dash = root.querySelector('.dash');
  drawFitted(dash, view);
  wireCharts(dash, view);
  wireActions(dash, view, go);
  if (!state.static) {
    wireProse(dash, {
      story: state.story,
      drafts: view.drafts,
      // Prose is the top of the share card as well as the top of the page, so writing
      // it redraws the card. Both calls debounce, so a sentence is one save and one
      // render, not one of each per keystroke.
      save: () => {
        save();
        paintShareImage(view);
      },
    });
    paintShareImage(view);
  }
}

/**
 * A shade-by-shade index rather than a "Less → More" gradient: each swatch is paired
 * with the range of values it actually stands for, so a reader can put a number to a
 * colour instead of guessing. Cut points come from the data, so the bands are this
 * person's own rhythm — see thresholds() in heatmap.js.
 */
function rampLegend(cuts, noun, { zero = 'none', unit = 'in a day', tail = '' } = {}) {
  // `zero: null` for charts whose marks start at level 1 (the gantt's blocks do).
  const band = (lo, hi) => (lo >= hi ? fmtNum(lo) : `${fmtNum(lo)}–${fmtNum(hi)}`);
  const bands = [
    ...(zero ? [[RAMP[0], zero]] : []),
    [RAMP[1], band(1, cuts[1] - 1)],
    [RAMP[2], band(cuts[1], cuts[2] - 1)],
    [RAMP[3], band(cuts[2], cuts[3] - 1)],
    [RAMP[4], `${fmtNum(cuts[3])}+`],
  ];
  // The caption belongs to the swatches, so it stays with them: wrapped onto a line of
  // its own it reads as a third thing in the legend rather than as the unit those
  // shades are counted in. The glyph key is the separate thing, and it is what drops
  // to the next line when there is no room.
  return `<span class="lg-ramp">${bands.map(([c, label]) => `<span class="lg"><i style="background:${c}"></i>${label}</span>`).join('')}
      <span class="lg-note">${esc(noun)} ${unit}</span></span>
    ${tail ? `<span class="lg-marks">${esc(tail)}</span>` : ''}`;
}

/**
 * The activity calendar, wide or stacked.
 *
 * The long grid is 53 weeks across; on a phone that is three screens of sideways
 * scrolling, so under about 520px the year is cut into months instead — the same
 * shades, the same cuts, read down the page like a wall calendar.
 */
function drawHeatmap(dash, v) {
  const host = dash.querySelector('#heat');
  if (!host) return;
  const metric = v.mActivity;
  const noun = metricOf(metric).noun;
  const calendar = v.cur.series[metric].calendar;
  const tip = (c) => `${fmtNum(c.count)} ${noun} · ${fmtDay(c.date)}`;
  const width = Math.max(240, host.clientWidth);
  if (width < 520) {
    // The gutter is in the stylesheet as well; they have to agree or the columns stop
    // meeting the card's padding.
    const blocks = monthBlocksHTML(calendar, { width, gap: 3, columns: 2, gutter: 20, tip });
    host.classList.add('stacked');
    host.innerHTML = blocks.markup;
    dash.querySelector('#heat-legend').innerHTML = rampLegend(blocks.cuts, noun);
    return;
  }
  host.classList.remove('stacked');
  wireHeatmap(dash, v.cur, metric, noun);
}

function wireHeatmap(dash, cur, metric, noun) {
  const host = dash.querySelector('#heat');
  const calendar = cur.series[metric].calendar;
  // Size cells to the card so the grid fills its width.
  const offset = calendar.length ? new Date(`${calendar[0].date}T00:00:00Z`).getUTCDay() : 0;
  const cols = Math.floor((calendar.length - 1 + offset) / 7) + 1;
  const gap = 3;
  const cell = Math.max(9, Math.min(22, Math.floor((host.clientWidth - 32) / cols) - gap));
  const L = layoutHeatmap(calendar, { cell, gap, padLeft: 32, padTop: 20 });
  // Each cell carries its own tooltip, so the delegated handler in store.js does the work
  // and there is no pixel hit-testing to keep in step with the layout.
  const body = heatmapSVG(L, { size: 11, tip: (c) => `${fmtNum(c.count)} ${noun} · ${fmtDay(c.date)}` });
  host.innerHTML = `<svg class="heat-svg" width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}">${body}</svg>`;
  // The calendar runs oldest to newest, so a scroller left at 0 opens a phone on the
  // start of the period — months of weeks nobody is looking for. Start at the end you
  // came to read; the fade wireScrollers() adds says the rest is behind you.
  host.scrollLeft = host.scrollWidth;
  dash.querySelector('#heat-legend').innerHTML = rampLegend(L.cuts, noun);
}

function wireCompare(dash, L, series, cur) {
  const svg = dash.querySelector('#cmp svg');
  const cross = svg.querySelector('.c-cross');
  const line = cross.querySelector('.c-x');
  const dots = [...cross.querySelectorAll('.c-dot')];
  svg.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const sx = (e.clientX - r.left) * (L.W / r.width);
    const i = Math.round(((sx - L.padL) / (L.W - L.padL - L.padR)) * (L.n - 1));
    if (i < 0 || i >= L.n) {
      cross.style.display = 'none';
      return hideTip();
    }
    const px = L.x(i);
    cross.style.display = '';
    line.setAttribute('x1', px);
    line.setAttribute('x2', px);
    const rows = series.map((s, si) => {
      const v = s.values[Math.min(i, s.values.length - 1)] || 0;
      dots[si].setAttribute('cx', px);
      dots[si].setAttribute('cy', L.y(v));
      return `<div class="line"><i style="--c:${s.color}"></i>${esc(s.label)}<b>${fmtNum(v)}</b></div>`;
    }).join('');
    showTip(`<div>Day ${i + 1} · ${fmtDay(addDays(cur.period.from, i))}</div>${rows}`, e.clientX, e.clientY - 12);
  });
  svg.addEventListener('mouseleave', () => {
    cross.style.display = 'none';
    hideTip();
  });
}

/**
 * Hovering a ribbon lights that one path and dims the rest; hovering a node lights every
 * path through it. The tooltip is the ribbon's own data-tip, shown by bindTips. Touch has
 * no hover, so a tap pins the same highlight and tooltip, and a second tap on it, or a tap
 * anywhere else, lets go.
 */
function wireSankey(dash) {
  const svg = dash.querySelector('.sankey');
  if (!svg) return;
  const ribbons = [...svg.querySelectorAll('.s-link')];
  let pinned = null;
  let pointer = 'mouse';
  const light = (on) => {
    svg.classList.add('focus');
    for (const p of ribbons) p.classList.toggle('on', on(p));
  };
  const clear = () => {
    svg.classList.remove('focus');
    for (const p of ribbons) p.classList.remove('on');
  };
  const through = (id) => (p) => p.dataset.nodes.split('|').includes(id);

  svg.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const id = e.target.dataset?.node;
    if (e.target.classList.contains('s-link')) light((p) => p === e.target);
    else if (id) light(through(id));
    else clear();
  });
  svg.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') clear();
  });

  dash.addEventListener('pointerdown', (e) => { pointer = e.pointerType; }, true);
  dash.addEventListener('click', (e) => {
    if (pointer === 'mouse') return;
    const hit = svg.contains(e.target) ? e.target.closest('.s-link, .s-node') : null;
    if (!hit || hit === pinned) {
      if (pinned) {
        pinned = null;
        clear();
        hideTip();
      }
      return;
    }
    pinned = hit;
    light(hit.classList.contains('s-link') ? (p) => p === hit : through(hit.dataset.node));
    showTip(esc(hit.dataset.tip), e.clientX, e.clientY - 8);
  });
}
