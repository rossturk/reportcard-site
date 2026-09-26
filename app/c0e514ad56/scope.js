import { pull, save, state, toast } from './store.js';
import {
  CATEGORIES, MAX_COMPARE, PRESETS, RESULTS, UNSET, coverage, dotCss, ensureMeta, esc, fmtDay, fmtNum, fmtRange,
  fmtSpan, isIncluded, isHighlighted, meta, periodLength, reasonsFor, resolvePeriod, resultOf, scopeModel,
  suggestGroups, today, unitName,
} from './model.js';
import { sparklineSVG } from './heatmap.js';
import { spanStart } from './gantt.js';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'included', label: 'Included' },
  { id: 'excluded', label: 'Excluded' },
  { id: 'unset', label: 'No result' },
];

const SORTS = {
  commits: (a, b) => b.unit.commits - a.unit.commits,
  recent: (a, b) => (b.unit.lastDay || '').localeCompare(a.unit.lastDay || ''),
  started: (a, b) => (spanStart(a.unit) || '').localeCompare(spanStart(b.unit) || ''),
  name: (a, b) => unitName(a.unit, state.story).localeCompare(unitName(b.unit, state.story)),
};

// View state that shouldn't persist: filters, selection, a half-typed merge name.
const ui = { query: '', filter: 'all', sort: 'commits', selected: new Set(), mergeName: '', showEarlier: false, open: new Set() };

let root = null;
let go = null;
let model = null;
let cov = null;

export function renderScope(el, navigate) {
  root = el;
  go = navigate;
  cov = coverage(state.data, state.story);
  model = state.data && cov.ok ? scopeModel(state.data, state.story) : null;
  const known = new Set(model ? [...model.active, ...model.earlierOnly].map((r) => r.unit.key) : []);
  for (const key of ui.selected) if (!known.has(key)) ui.selected.delete(key);

  root.innerHTML = `<div class="scope">
    <div class="page">
      <header class="page-head">
        <div class="eyebrow">Step 1 of 2</div>
        <h1>Scope</h1>
        <p class="lede">Choose the period, decide which projects count, and record what came of each one.</p>
      </header>
      ${periodPanel()}
      ${projectsPanel()}
    </div>
    <footer class="wizard-foot"><div class="foot-inner">
      <div class="foot-stats" id="foot-stats"></div>
      <button type="button" class="btn primary lg" data-act="build">Build dashboard →</button>
    </div></footer>
  </div>`;

  const scope = root.querySelector('.scope');
  scope.addEventListener('click', onClick);
  scope.addEventListener('change', onChange);
  scope.addEventListener('input', onInput);
  scope.addEventListener('keydown', onKeydown);
  scope.querySelector('details.earlier')?.addEventListener('toggle', (e) => { ui.showEarlier = e.target.open; });
  refreshCounts();
}

/**
 * Redraw step 1 without throwing away where the person was.
 *
 * Every edit here re-renders the whole step, which is the simplest thing that can
 * work and is invisible until you are typing in one of the inputs it replaces — then
 * the page jumps to the top and the caret is gone mid-word. Scroll position is
 * captured and restored around the render; pass the id of the field being edited and
 * its focus and caret come back with it.
 */
function rerender(focusId) {
  const focused = focusId && document.getElementById(focusId);
  const caret = focused ? focused.selectionStart : null;
  const scroll = window.scrollY;
  renderScope(root, go);
  window.scrollTo(0, scroll);
  restoreCaret(focusId, caret);
}

/**
 * Put the person back in the field they were typing in. The element is gone — the
 * re-render replaced it — so this is the new one wearing the same id, and the caret
 * offset only means anything for the inputs that have one.
 */
function restoreCaret(focusId, caret) {
  const el = focusId && document.getElementById(focusId);
  if (!el) return;
  el.focus();
  if (caret != null && el.setSelectionRange) el.setSelectionRange(caret, caret);
}

/* ---------------------------------------------------------------- period */

function periodPanel() {
  const period = resolvePeriod(state.story.period);
  const n = state.story.compare;
  const pulled = state.data
    ? `<span class="muted">History pulled ${fmtDay(state.data.fetchedAt.slice(0, 10))}, reaching back to ${fmtDay(state.data.from.slice(0, 10))}</span>`
    : '';
  const compareLabel = (i) => (i === 0 ? 'Nothing' : i === 1 ? 'Previous period' : `${i} previous`);

  return `<section class="panel">
    <div class="panel-head"><h2>Time period</h2>${pulled}</div>
    <div class="period-grid">
      <div>
        <span class="label">Study</span>
        <div class="seg" role="group" aria-label="Period length">
          ${PRESETS.map((p) => `<button type="button" data-preset="${p.id}" aria-pressed="${period.preset === p.id}">${p.label}</button>`).join('')}
          <button type="button" data-preset="custom" aria-pressed="${period.preset === 'custom'}">Custom</button>
        </div>
      </div>
      <div class="dates">
        <label><span class="label">From</span><input type="date" id="p-from" value="${period.from}" max="${today()}"></label>
        <label><span class="label">To</span><input type="date" id="p-to" value="${period.to}" max="${today()}"></label>
      </div>
      <div>
        <span class="label">Compare with</span>
        <div class="seg" role="group" aria-label="Comparison">
          ${Array.from({ length: MAX_COMPARE + 1 }, (_, i) =>
            `<button type="button" data-compare="${i}" aria-pressed="${n === i}">${compareLabel(i)}</button>`).join('')}
        </div>
      </div>
    </div>
    <div class="period-summary">
      <span><b>${fmtRange(period.from, period.to)}</b>&ensp;·&ensp;${fmtNum(periodLength(period))} days</span>
      ${cov.previous.map((p) => `<span>vs&ensp;${fmtRange(p.from, p.to)}</span>`).join('')}
    </div>
    <div class="pull-row" id="pull-row">${pullRow()}</div>
  </section>`;
}

function pullRow() {
  const job = state.job;
  const need = cov.needFrom;
  if (job?.state === 'running') {
    return `<span class="spinner" aria-hidden="true"></span><span class="progress">${esc(job.message)}</span>`;
  }
  const failed = job?.state === 'error' ? `<span class="warn">Last pull failed: ${esc(job.message)}</span>` : '';
  if (!state.data) {
    return `${failed}<span>Nothing pulled yet. Commits are read through <code>gh</code>, private repos included.</span>
      <button type="button" class="btn primary" data-act="pull">Pull history from ${fmtDay(need)}</button>`;
  }
  if (!cov.ok) {
    return `${failed}<span class="warn">This needs history back to <b>${fmtDay(need)}</b>; what's pulled starts ${fmtDay(cov.pulledFrom)}.</span>
      <button type="button" class="btn primary" data-act="pull">Pull history from ${fmtDay(need)}</button>`;
  }
  return `${failed}<span class="muted">Pulled history covers this period${state.story.compare ? ' and its comparison' : ''}.</span>
    <button type="button" class="btn sm" data-act="pull">Refresh from GitHub</button>`;
}

export function updatePullRow() {
  const row = document.getElementById('pull-row');
  if (row && cov) row.innerHTML = pullRow();
}

/* -------------------------------------------------------------- projects */

function projectsPanel() {
  if (!model) {
    const why = state.data ? 'Pull history covering this period to see its projects.' : 'Pull your history to see projects.';
    return `<section class="panel"><div class="panel-head"><h2>Projects</h2></div><p class="muted">${why}</p></section>`;
  }
  const rows = visibleRows();
  const allSelected = rows.length > 0 && rows.every((r) => ui.selected.has(r.unit.key));

  return `<section class="panel">
    <div class="panel-head"><h2>Projects</h2><span class="muted" id="proj-count"></span></div>
    ${suggestions()}
    <div class="toolbar">
      <input type="search" id="q" placeholder="Filter projects" value="${esc(ui.query)}" aria-label="Filter projects">
      <div class="seg sm" role="group" aria-label="Show">
        ${FILTERS.map((f) => `<button type="button" data-filter="${f.id}" aria-pressed="${ui.filter === f.id}">${f.label}<span class="n" data-count="${f.id}"></span></button>`).join('')}
      </div>
      <label class="sort">Sort
        <select class="plain" id="sort">
          ${[['commits', 'Most commits'], ['recent', 'Most recent'], ['started', 'Started'], ['name', 'Name']]
            .map(([id, label]) => `<option value="${id}" ${ui.sort === id ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </label>
    </div>
    <div id="bulk">${bulkBar()}</div>
    <div class="table" role="table" aria-label="Projects">
      <div class="tr th" role="row">
        <div class="c-sel"><input type="checkbox" data-act="select-all" ${allSelected ? 'checked' : ''} aria-label="Select all shown"></div>
        <div class="c-name">Project</div>
        <div class="c-cat">Category</div>
        <div class="c-act">Activity</div>
        <div class="c-num c-commits">Commits</div>
        <div class="c-num c-releases">Rel.</div>
        <div class="c-res">Outcome &amp; why</div>
        <div class="c-more"></div>
      </div>
      ${rows.map((r) => rowHTML(r)).join('') || '<div class="table-empty">No projects match.</div>'}
    </div>
    ${earlierSection()}
    ${reasonLists()}
  </section>`;
}

function matchesQuery(row) {
  const q = ui.query.trim().toLowerCase();
  return !q || `${unitName(row.unit, state.story)} ${row.unit.fullName}`.toLowerCase().includes(q);
}

const passesFilter = (row) => matchesQuery(row) && matchesFilter(row, ui.filter);

function matchesFilter(row, filter) {
  const inc = isIncluded(row.unit, state.story);
  if (filter === 'included') return inc;
  if (filter === 'excluded') return !inc;
  if (filter === 'unset') return inc && !meta(state.story, row.unit.key).result;
  return true;
}

const visibleRows = () => model.active.filter(passesFilter).sort(SORTS[ui.sort]);

/**
 * One project's row: select box, editable name and meta line, category, sparkline,
 * commits against the previous period, releases, outcome and its reason, the include
 * and highlight toggles, and the drawer when it is open.
 *
 * `earlier` rows are projects with no activity in this period at all — they are here
 * only so a comparison can mention them, so everything that would invite an edit
 * collapses to a placeholder.
 */
function rowHTML({ unit: u, prevCommits, earlierCommits }, { earlier = false } = {}) {
  const m = meta(state.story, u.key);
  const inc = isIncluded(u, state.story);
  const name = unitName(u, state.story);
  const res = resultOf(m.result);
  const selected = ui.selected.has(u.key);
  const open = ui.open.has(u.key);
  const starred = isHighlighted(u, state.story);

  const reasons = reasonsFor(m.result || '');
  const outcome = earlier
    ? '<span class="quiet">Comparison only</span>'
    : `<div class="outcome">
        <div class="result"><i style="${dotCss(res)}"></i>
          <select data-act="result" aria-label="Outcome for ${esc(name)}">
            ${[UNSET, ...RESULTS].map((r) => `<option value="${r.id}" ${r.id === res.id ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
          </select>
        </div>
        <input type="text" class="why-in" data-act="reason" value="${esc(m.reason || '')}"
          ${reasons.length ? `list="reason-${esc(m.result)}" placeholder="${esc(reasons[0])}"` : 'placeholder="Set an outcome first" disabled'}
          aria-label="Reason for ${esc(name)}">
      </div>`;

  const activity = earlier
    ? '<span class="quiet">No commits</span>'
    : `<span class="spark-wrap" title="${esc(fmtSpan(u.firstDay, u.lastDay))}">${sparklineSVG(u.days, cov.current)}</span>`;

  return `<div class="tr${inc ? '' : ' off'}${u.isGroup ? ' grp' : ''}${selected ? ' sel' : ''}${open ? ' open' : ''}" role="row" data-key="${esc(u.key)}">
    <div class="c-sel"><input type="checkbox" data-act="select" ${selected ? 'checked' : ''} aria-label="Select ${esc(name)}"></div>

    <div class="c-name">
      <input type="text" class="name-in" data-act="rename" value="${esc(name)}" spellcheck="false" aria-label="Name for ${esc(u.fullName)}">
      <div class="meta">${metaLine(u)}</div>
    </div>

    <div class="c-cat">${earlier ? '' : `<input type="text" class="cat-in" list="category-options" data-act="category"
      value="${esc(m.category || '')}" placeholder="Category" aria-label="Category for ${esc(name)}">`}</div>

    <div class="c-act">${activity}</div>
    <div class="c-num c-commits">${earlier ? `<b class="quiet">—</b><span class="prev">${fmtNum(earlierCommits)} earlier</span>`
      : `<b>${fmtNum(u.commits)}</b>${prevCommits != null ? `<span class="prev">${fmtNum(prevCommits)} prev</span>` : ''}`}</div>
    <div class="c-num c-releases"><b${earlier || !u.releases.length ? ' class="quiet"' : ''}>${earlier ? '—' : u.releases.length || '·'}</b></div>
    <div class="c-res">${outcome}</div>

    <div class="c-more">
      <button type="button" class="icon switch-in${inc ? ' on' : ''}" data-act="include" role="switch" aria-checked="${inc}" aria-label="Include ${esc(name)}" title="${inc ? 'Included' : 'Excluded'}"></button>
      <button type="button" class="icon star${starred ? ' on' : ''}" data-act="highlight" aria-pressed="${starred}" aria-label="Highlight ${esc(name)}" title="Highlight on the dashboard">★</button>
      <button type="button" class="icon chev" data-act="expand" aria-expanded="${open}" aria-label="More about ${esc(name)}">${open ? '▴' : '▾'}</button>
    </div>

    ${open ? drawer(u, m, name) : ''}
  </div>`;
}

/** One quiet line: where it lives, what it's written in, and whether it's new. */
function metaLine(u) {
  const bits = [];
  if (u.isGroup) bits.push(`<span class="repo">${u.members.length} repos</span>`);
  else bits.push(`<span class="repo">${esc(u.fullName)}</span>`);
  const langs = (u.languages || []).slice(0, 2).map((l) => l.name);
  if (langs.length) bits.push(`<span>${esc(langs.join(', '))}${u.languages.length > 2 ? ` +${u.languages.length - 2}` : ''}</span>`);
  if (u.isPrivate) bits.push('<span>private</span>');
  if (u.isNew) bits.push('<span class="is-new">new</span>');
  return bits.join('<span class="dot">·</span>');
}

/** Everything that would otherwise pile up in the row. */
function drawer(u, m, name) {
  const fromGitHub = u.description || '';
  const own = m.description?.trim() || '';
  const edited = Boolean(own) && own !== fromGitHub;
  const source = edited
    ? '<button type="button" class="link" data-act="reset-desc">reset to GitHub</button>'
    : fromGitHub ? '<span class="src-note">from GitHub</span>' : '<span class="src-note">nothing on GitHub yet</span>';

  const repos = u.isGroup
    ? `<div class="field-repos">
        <span class="label">Merged repos <button type="button" class="link" data-act="ungroup">unmerge all</button></span>
        <div class="repo-chips">${u.members.map((r) => `<span class="chip">${esc(r.nameWithOwner)}<b>${fmtNum(r.commits)}</b>
          <button type="button" data-act="unmerge" data-repo="${esc(r.key)}" aria-label="Split ${esc(r.name)} out">×</button></span>`).join('')}</div>
      </div>`
    : '';

  return `<div class="drawer">
    ${repos}
    <div class="drawer-fields">
      <!-- A div, not a label. The source note can be a button, and a label with no for=
           attribute binds to its first labelable descendant: that button, not the
           textarea. The label then forwards clicks to "reset to GitHub" and wipes the
           text. The textarea carries its own aria-label, so nothing is lost. -->
      <div class="field-desc">
        <span class="label">Description ${source}</span>
        <textarea rows="2" data-act="description" placeholder="Say what this project is"
          aria-label="Description for ${esc(name)}">${esc(own || fromGitHub)}</textarea>
      </div>
      <label class="field-sm">
        <span class="label">Note</span>
        <input type="text" data-act="note" value="${esc(m.note || '')}" placeholder="Optional aside" aria-label="Note for ${esc(name)}">
      </label>
      <label class="field-sm">
        <span class="label">Link</span>
        <input type="url" data-act="url" value="${esc(m.url || '')}" placeholder="https://…"
          spellcheck="false" aria-label="Link for ${esc(name)}">
      </label>
      <div class="field-shot">
        <span class="label">Screenshot ${m.image ? '<button type="button" class="link" data-act="drop-shot">remove</button>' : ''}</span>
        ${m.image
          ? `<img class="shot-thumb" src="${esc(m.image)}" alt="Screenshot of ${esc(name)}">`
          : `<label class="shot-drop">
              <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-act="shot">
              <span>Choose an image…</span>
            </label>`}
      </div>
      <label class="check drawer-star">
        <input type="checkbox" data-act="highlight-box" ${isHighlighted(u, state.story) ? 'checked' : ''}>
        Highlight on the dashboard
      </label>
    </div>
  </div>`;
}

/** One datalist per result, so the "why" suggestions match the outcome. */
function reasonLists() {
  return `<datalist id="category-options">${CATEGORIES.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist>`
    + [...RESULTS].map((r) => `<datalist id="reason-${esc(r.id)}">${reasonsFor(r.id).map((x) => `<option value="${esc(x)}"></option>`).join('')}</datalist>`).join('');
}

function earlierSection() {
  if (!model.earlierOnly.length) return '';
  // Results don't apply to these rows, so the "No result" filter shouldn't hide them.
  const rows = model.earlierOnly
    .filter((r) => matchesQuery(r) && (ui.filter === 'unset' || matchesFilter(r, ui.filter)))
    .sort(SORTS[ui.sort]);
  if (!rows.length) return '';
  return `<details class="earlier"${ui.showEarlier || ui.query.trim() ? ' open' : ''}>
    <summary>${rows.length} projects only active in the comparison periods</summary>
    <p class="muted sm">They're not on this period's charts, but they count toward the comparison. Exclude anything that shouldn't.</p>
    <div class="table">${rows.map((r) => rowHTML(r, { earlier: true })).join('')}</div>
  </details>`;
}

function suggestions() {
  const picks = suggestGroups(model.active.map((r) => r.unit)).slice(0, 5);
  if (!picks.length) return '';
  return `<div class="suggest"><span class="label">Looks related</span>
    ${picks.map((p) => `<button type="button" class="btn sm" data-suggest="${esc(p.stem)}">${esc(p.units.map((u) => u.name).join(' + '))}</button>`).join('')}
  </div>`;
}

/* ------------------------------------------------------------------ bulk */

const allRows = () => [...model.active, ...model.earlierOnly];
const rowByKey = (key) => allRows().find((r) => r.unit.key === key);

function defaultMergeName() {
  const units = [...ui.selected].map(rowByKey).filter(Boolean).map((r) => r.unit);
  const group = units.find((u) => u.isGroup);
  if (group) return group.name;
  const lead = [...units].sort((a, b) => b.commits - a.commits)[0];
  return lead ? unitName(lead, state.story) : '';
}

function bulkBar() {
  const n = ui.selected.size;
  if (!n) return '';
  const merge = n >= 2
    ? `<input type="text" id="merge-name" value="${esc(ui.mergeName || defaultMergeName())}" aria-label="Merged project name">
       <button type="button" class="btn primary sm" data-bulk="merge">Merge into one project</button>`
    : '<span class="muted sm">Select two or more to merge</span>';
  return `<div class="bulk" role="region" aria-label="Selected projects">
    <b>${n} selected</b>
    ${merge}
    <span class="bulk-sep" aria-hidden="true"></span>
    <button type="button" class="btn sm" data-bulk="include">Include</button>
    <button type="button" class="btn sm" data-bulk="exclude">Exclude</button>
    <select class="plain" data-bulk="result" aria-label="Set result for selected">
      <option value="__">Set result…</option>
      ${[UNSET, ...RESULTS].map((r) => `<option value="${r.id}">${esc(r.label)}</option>`).join('')}
    </select>
    <button type="button" class="btn ghost sm" data-bulk="clear">Clear</button>
  </div>`;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';

function mergeSelected() {
  const story = state.story;
  const keys = [...ui.selected];
  const name = (document.getElementById('merge-name')?.value || '').trim() || defaultMergeName();
  const picked = story.groups.filter((g) => keys.includes(g.id));
  const repoKeys = [...new Set([...picked.flatMap((g) => g.keys), ...keys.filter((k) => !k.startsWith('group:'))])];
  const donor = keys.map((k) => story.projects[k]).find((m) => m?.result || m?.note);

  let target;
  if (picked.length === 1) {
    target = picked[0];
    target.keys = repoKeys;
    target.name = name;
  } else {
    story.groups = story.groups.filter((g) => !picked.includes(g));
    for (const g of picked) delete story.projects[g.id];
    target = { id: `group:${slug(name)}-${Date.now().toString(36)}`, name, keys: repoKeys };
    story.groups.push(target);
  }
  // Keep a result or note someone already wrote, rather than silently dropping it.
  const tm = ensureMeta(story, target.id);
  if (donor && !tm.result && !tm.note) Object.assign(tm, { result: donor.result || '', note: donor.note || '' });

  ui.selected.clear();
  ui.mergeName = '';
  save();
  rerender();
  toast(`Merged ${repoKeys.length} repos into ${name}`);
}

/**
 * A snapshot of the merge structure, so a destructive edit can be handed back.
 *
 * Only groups and their annotations: per-repo metadata isn't touched by unmerging, and
 * copying the whole story on every click would be wasteful.
 */
function snapshotGroups(story) {
  return JSON.stringify({
    groups: story.groups,
    annotations: Object.fromEntries(
      story.groups.map((g) => [g.id, story.projects[g.id]]).filter(([, m]) => m),
    ),
  });
}

function restoreGroups(snapshot) {
  const { groups, annotations } = JSON.parse(snapshot);
  const story = state.story;
  story.groups = groups;
  for (const [id, meta] of Object.entries(annotations)) story.projects[id] = meta;
  save();
  rerender();
}

function unmerge(groupId, repoKey) {
  const story = state.story;
  const group = story.groups.find((g) => g.id === groupId);
  if (!group) return;
  const before = snapshotGroups(story);
  const name = group.name;
  group.keys = group.keys.filter((k) => k !== repoKey);
  if (group.keys.length < 2) {
    // One repo left isn't a merge; hand the group's annotation to it if it has none.
    const [last] = group.keys;
    const gm = story.projects[group.id];
    if (last && gm && !story.projects[last]?.result && !story.projects[last]?.note) {
      Object.assign(ensureMeta(story, last), { result: gm.result || '', note: gm.note || '' });
    }
    story.groups = story.groups.filter((g) => g !== group);
    delete story.projects[group.id];
  }
  save();
  rerender();
  toast(`Split out of ${name}`, { run: () => restoreGroups(before) });
}

function ungroup(groupId) {
  const before = snapshotGroups(state.story);
  const name = state.story.groups.find((g) => g.id === groupId)?.name || 'the merge';
  state.story.groups = state.story.groups.filter((g) => g.id !== groupId);
  delete state.story.projects[groupId];
  ui.selected.delete(groupId);
  save();
  rerender();
  toast(`Unmerged ${name}`, { run: () => restoreGroups(before) });
}

/** Screenshots go to the server as raw bytes; it stores them by content hash. */
async function uploadShot(key, file) {
  if (!file) return;
  try {
    const res = await fetch('/api/image', { method: 'POST', headers: { 'content-type': file.type }, body: file });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'upload failed');
    const meta = ensureMeta(state.story, key);
    meta.image = body.url;
    // A screenshot is only worth having if the project is on the dashboard.
    if (meta.highlight !== true) meta.highlight = true;
    save();
    rerender();
    toast('Screenshot added');
  } catch (err) {
    toast(err.message);
  }
}

function rename(key, value) {
  const story = state.story;
  const group = story.groups.find((g) => g.id === key);
  const row = rowByKey(key);
  const next = value.trim();
  if (group) {
    if (next) group.name = next;
  } else {
    const m = ensureMeta(story, key);
    m.name = next && next !== row?.unit.name ? next : '';
  }
  save();
}

/* ---------------------------------------------------------------- counts */

function refreshCounts() {
  const foot = document.getElementById('foot-stats');
  const build = root.querySelector('[data-act="build"]');
  if (!model) {
    foot.innerHTML = '<span class="muted">Pull history covering the period to continue.</span>';
    build.disabled = true;
    return;
  }
  const included = model.active.filter((r) => isIncluded(r.unit, state.story));
  const commits = included.reduce((n, r) => n + r.unit.commits, 0);
  const unset = included.filter((r) => !meta(state.story, r.unit.key).result).length;
  const starred = included.filter((r) => isHighlighted(r.unit, state.story)).length;
  foot.innerHTML = `<span><b>${included.length}</b> projects</span><span><b>${fmtNum(commits)}</b> commits</span>
    ${unset ? `<span class="muted"><b>${unset}</b> without a result</span>` : '<span class="muted">Every project has a result</span>'}
    <span class="muted"><b>${starred}</b> highlighted</span>`;
  build.disabled = included.length === 0;

  document.getElementById('proj-count').textContent = `${included.length} of ${model.active.length} included`;
  for (const f of FILTERS) {
    const el = root.querySelector(`[data-count="${f.id}"]`);
    if (el) el.textContent = model.active.filter((r) => matchesFilter(r, f.id)).length;
  }
}

/* ---------------------------------------------------------------- events */

/**
 * One delegated click handler for the whole step, branching on data attributes.
 *
 * It is long because the step is: period presets and the compare count, the filter and
 * the sort, applying a merge suggestion, the bulk bar, the two navigation actions, and
 * then the per-row controls — include, expand, highlight, drop a screenshot, reset a
 * description, unmerge, ungroup. Almost every branch ends in save() and a rerender();
 * the ones that destroy something (a merge, an unmerge) offer an undo through the
 * toast instead of asking first.
 *
 * Delegation rather than per-row listeners because rerender() replaces every row.
 */
function onClick(e) {
  const t = e.target.closest('[data-preset], [data-compare], [data-filter], [data-suggest], [data-bulk], [data-act]');
  if (!t || t.tagName === 'SELECT' || t.type === 'checkbox') return;
  const key = t.closest('[data-key]')?.dataset.key;

  if (t.dataset.preset) {
    const p = resolvePeriod(state.story.period);
    state.story.period = t.dataset.preset === 'custom' ? { preset: 'custom', from: p.from, to: p.to } : { preset: t.dataset.preset };
    save();
    rerender();
  } else if (t.dataset.compare) {
    state.story.compare = Number(t.dataset.compare);
    save();
    rerender();
  } else if (t.dataset.filter) {
    ui.filter = t.dataset.filter;
    rerender();
  } else if (t.dataset.suggest) {
    const pick = suggestGroups(model.active.map((r) => r.unit)).find((p) => p.stem === t.dataset.suggest);
    if (!pick) return;
    ui.selected = new Set(pick.units.map((u) => u.key));
    ui.mergeName = pick.stem[0].toUpperCase() + pick.stem.slice(1);
    rerender('merge-name');
    document.getElementById('merge-name')?.select();
  } else if (t.dataset.bulk) {
    bulk(t.dataset.bulk);
  } else if (t.dataset.act === 'pull') {
    pull(cov.needFrom);
  } else if (t.dataset.act === 'build') {
    go('dashboard');
  } else if (t.dataset.act === 'include') {
    const m = ensureMeta(state.story, key);
    m.include = m.include === false;
    t.setAttribute('aria-checked', String(m.include));
    t.closest('.tr').classList.toggle('off', !m.include);
    save();
    refreshCounts();
  } else if (t.dataset.act === 'expand') {
    if (ui.open.has(key)) ui.open.delete(key);
    else ui.open.add(key);
    rerender();
  } else if (t.dataset.act === 'highlight') {
    const m = ensureMeta(state.story, key);
    m.highlight = !m.highlight;
    t.classList.toggle('on', m.highlight);
    t.setAttribute('aria-pressed', String(Boolean(m.highlight)));
    // The drawer holds a second control for the same field; keep the two in step.
    const box = t.closest('.tr').querySelector('[data-act="highlight-box"]');
    if (box) box.checked = Boolean(m.highlight);
    save();
    refreshCounts();
  } else if (t.dataset.act === 'drop-shot') {
    ensureMeta(state.story, key).image = '';
    save();
    rerender();
  } else if (t.dataset.act === 'reset-desc') {
    ensureMeta(state.story, key).description = '';
    save();
    rerender();
  } else if (t.dataset.act === 'unmerge') {
    unmerge(key, t.dataset.repo);
  } else if (t.dataset.act === 'ungroup') {
    ungroup(key);
  }
}

function bulk(action) {
  const keys = [...ui.selected];
  if (action === 'merge') return mergeSelected();
  if (action === 'clear') {
    ui.selected.clear();
    return rerender();
  }
  if (action === 'include' || action === 'exclude') {
    for (const k of keys) ensureMeta(state.story, k).include = action === 'include';
    save();
    rerender();
  }
}

/**
 * The same dispatch for controls that change rather than click: the custom period's
 * dates, the sort, row and select-all checkboxes, a row's outcome (which also decides
 * whether its reason field is usable), a screenshot upload, the highlight box, an
 * inline rename, and the bulk apply-to-selected. Same rule: persist, then rerender.
 */
function onChange(e) {
  const t = e.target;
  const key = t.closest('[data-key]')?.dataset.key;

  if (t.id === 'p-from' || t.id === 'p-to') {
    const from = document.getElementById('p-from').value;
    const to = document.getElementById('p-to').value;
    if (!from || !to) return;
    state.story.period = { preset: 'custom', from, to };
    save();
    rerender();
  } else if (t.id === 'sort') {
    ui.sort = t.value;
    rerender();
  } else if (t.dataset.act === 'select') {
    if (t.checked) ui.selected.add(key);
    else ui.selected.delete(key);
    t.closest('.tr').classList.toggle('sel', t.checked);
    document.getElementById('bulk').innerHTML = bulkBar();
  } else if (t.dataset.act === 'select-all') {
    for (const r of visibleRows()) {
      if (t.checked) ui.selected.add(r.unit.key);
      else ui.selected.delete(r.unit.key);
    }
    rerender();
  } else if (t.dataset.act === 'result') {
    ensureMeta(state.story, key).result = t.value;
    t.previousElementSibling.style.cssText = dotCss(resultOf(t.value));
    save();
    refreshCounts();
    const whyInput = t.closest('.tr').querySelector('[data-act="reason"]');
    if (whyInput) {
      const list = reasonsFor(t.value);
      whyInput.disabled = list.length === 0;
      whyInput.placeholder = list.length ? list[0] : 'Set an outcome first';
      if (list.length) whyInput.setAttribute('list', `reason-${t.value}`);
      else whyInput.removeAttribute('list');
    }
  } else if (t.dataset.act === 'shot') {
    uploadShot(t.closest('[data-key]').dataset.key, t.files?.[0]);
  } else if (t.dataset.act === 'highlight-box') {
    ensureMeta(state.story, key).highlight = t.checked;
    save();
    rerender();
  } else if (t.dataset.act === 'rename') {
    rename(key, t.value);
    if (!t.value.trim()) t.value = unitName(rowByKey(key).unit, state.story);
  } else if (t.dataset.bulk === 'result' && t.value !== '__') {
    for (const k of ui.selected) ensureMeta(state.story, k).result = t.value;
    save();
    rerender();
  }
}

function onInput(e) {
  const t = e.target;
  if (t.id === 'q') {
    ui.query = t.value;
    rerender('q');
  } else if (t.id === 'merge-name') {
    ui.mergeName = t.value;
  } else if (t.dataset.act === 'description') {
    const key = t.closest('[data-key]').dataset.key;
    const fromGitHub = rowByKey(key)?.unit.description || '';
    const next = t.value.trim();
    const edited = Boolean(next) && next !== fromGitHub;
    ensureMeta(state.story, key).description = edited ? t.value : '';
    save();
    // Swap the source note without a re-render, which would steal focus mid-sentence.
    const label = t.closest('.field-desc').querySelector('.label');
    const note = edited
      ? '<button type="button" class="link" data-act="reset-desc">reset to GitHub</button>'
      : `<span class="src-note">${fromGitHub ? 'from GitHub' : 'nothing on GitHub yet'}</span>`;
    label.innerHTML = `Description ${note}`;
  } else if (t.dataset.act === 'category' || t.dataset.act === 'reason') {
    ensureMeta(state.story, t.closest('[data-key]').dataset.key)[t.dataset.act] = t.value;
    save();
  } else if (t.dataset.act === 'note' || t.dataset.act === 'url') {
    ensureMeta(state.story, t.closest('[data-key]').dataset.key)[t.dataset.act] = t.value;
    save();
  }
}

function onKeydown(e) {
  const t = e.target;
  if (e.key === 'Enter' && t.dataset.act === 'rename') t.blur();
  if (e.key === 'Enter' && t.id === 'merge-name') mergeSelected();
  if (e.key === 'Escape' && ui.selected.size && !t.closest('input, select')) {
    ui.selected.clear();
    rerender();
  }
}
