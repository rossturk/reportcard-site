/**
 * The report's own sentences.
 *
 * A report card is otherwise all data and no story: "widdl — 492 commits — Abandoned"
 * is a fact, not a reason. These are the fixed slots where the reason goes — one lede
 * under the date range, one line under each section heading — and the editor that fills
 * them.
 *
 * Two rules shape everything here. A slot with nothing in it renders nothing at all, so
 * a report without prose is the report as it has always been. And every empty slot
 * arrives with a draft already written from that section's own numbers, because people
 * edit a draft and do not fill an empty box.
 */
import {
  PROMPTS, capFor, delta, esc, fmtNum, fmtSpan, introOf, metricOf, parseInline,
  resultFor, setIntro, totalOf, unitName,
} from './model.js';

/* ------------------------------------------------------------------- drafts */

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const hourWord = (h) => {
  const hour = ((h % 24) + 24) % 24;
  if (hour === 0) return 'midnight';
  if (hour === 12) return 'noon';
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
};
const list = (names) => (names.length < 2
  ? names.join('')
  : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * The change, said out loud, as the words that go between "Commits are" and "the period
 * before". delta() draws an arrow beside its text and a sentence can't, so the
 * direction becomes a word. Returns null when there is nothing to compare against —
 * callers write no sentence rather than print "null".
 */
function movement(d) {
  if (!d) return null;
  if (d.dir === 0) return 'about level with';
  // delta() says "from 0" when the earlier period had nothing, and "up from 0 on the
  // period before" is not a sentence anyone would keep.
  if (d.text === 'from 0') return 'up from nothing in';
  return `${d.dir > 0 ? 'up' : 'down'} ${d.text.replace(/^[+−-]/, '')} on`;
}

/**
 * A first line per slot, derived from the numbers the section has already computed.
 *
 * Nothing here is saved. A draft is an offer: it is rendered into the empty slot, and
 * only becomes part of the report when someone accepts it — at which point it is stored
 * as ordinary text, with no mark saying where it came from. So these are written to be
 * a true opening sentence someone would keep, not a caption of the chart below them.
 */
export function draftsFor(view) {
  const { cur, prev, story, metric, noun, clock, highlights, breakdowns, sd } = view;
  const t = cur.totals;
  const out = {};

  const ranked = [...cur.included].sort((a, b) => totalOf(b, metric) - totalOf(a, metric));
  const lead = ranked[0];
  const leadShare = lead ? pct(totalOf(lead, metric), t[metric === 'lines' ? 'lines' : 'commits']) : 0;

  out.page = lead && leadShare >= 20
    ? `Most of the year went to ${unitName(lead, story)} — ${leadShare}% of the ${noun} — `
      + `with ${t.projects - 1} other project${t.projects === 2 ? '' : 's'} around it.`
    : `${fmtNum(t.commits)} commits across ${t.projects} projects, `
      + `${fmtSpan(cur.period.from, cur.period.to)}.`;

  out.projects = `${t.projects} projects were active`
    + (t.newProjects ? `, ${t.newProjects} of them started in this period` : '')
    + (t.releases ? `, and ${t.releases} release${t.releases === 1 ? '' : 's'} went out` : '')
    + '.';

  if (highlights.length) {
    const share = pct(highlights.reduce((n, u) => n + u.commits, 0), t.commits);
    const names = highlights.slice(0, 3).map((u) => unitName(u, story));
    out.highlights = highlights.length <= 3
      ? `${list(names)} — ${share}% of the period's commits between them.`
      : `${highlights.length} projects worth stopping on, ${share}% of the period's commits between them.`;
  }

  out.activity = `Work landed on ${fmtNum(t.activeDays)} of ${fmtNum(t.days)} days, `
    + `with a longest run of ${t.streak}.`;

  if (clock.total) {
    const s = clock.schedule;
    // Nights are the striking fact when there are any; otherwise the working window is
    // the honest one, and saying "9% at night" as an opening line says nothing.
    out.hours = s.nightShare >= 0.2
      ? `${Math.round(s.nightShare * 100)}% of the ${clock.noun} land between 10pm and 6am.`
      : `Most of the work happens between ${hourWord(s.window.from)} and ${hourWord(s.window.to)}, `
        + `busiest around ${hourWord(s.peakHour)}.`;
  }

  const languages = breakdowns.find((b) => b.id === 'language')?.data;
  if (languages?.slices.length) {
    const top = languages.slices[0];
    out['types:language'] = `${top.label} is ${pct(top.count, languages.total)}% of the lines changed, `
      + `across ${languages.slices.length} language${languages.slices.length === 1 ? '' : 's'}.`;
  }
  const categories = breakdowns.find((b) => b.id === 'category')?.data;
  if (categories?.slices.length) {
    const top = categories.slices[0];
    out['types:category'] = `${top.label} is the biggest group at ${top.count} of `
      + `${categories.total} projects, across ${categories.slices.length} categories.`;
  }

  // Where the effort went: which outcome the work actually flowed into.
  const byResult = new Map();
  for (const unit of cur.included) {
    const r = resultFor(unit, story);
    byResult.set(r.label, (byResult.get(r.label) || 0) + totalOf(unit, metric));
  }
  const [label, value] = [...byResult.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  if (label && sd.paths.length) {
    const whole = [...byResult.values()].reduce((n, v) => n + v, 0);
    out.effort = `${pct(value, whole)}% of the ${metricOf(metric).noun} went to projects `
      + `marked ${label.toLowerCase()}.`;
  }

  const move = prev && movement(delta(t.commits, prev.totals.commits));
  if (move) {
    out.compare = `Commits are ${move} the period before`
      + ` (${fmtNum(t.commits)} against ${fmtNum(prev.totals.commits)}).`;
  }

  // A slot with no draft is normal — the section may not be in this report at all — and
  // its prompt stands on its own.
  return out;
}

/* ------------------------------------------------------------------ markup */

/** Emphasis and code, as tags. The runs come from parseInline, so the image marks up the same words. */
const inline = (text) => parseInline(text).map((run) => {
  if (run.code) return `<code>${esc(run.text)}</code>`;
  const body = esc(run.text).replace(/\n/g, '<br>');
  const italic = run.italic ? `<em>${body}</em>` : body;
  return run.bold ? `<strong>${italic}</strong>` : italic;
}).join('');

/** Paragraph breaks are the structure; emphasis is the only markup inside one. */
const paragraphs = (text) => text.split('\n\n').map((para) => `<p>${inline(para)}</p>`).join('');

/** Drafts declined in this session. Never stored: an unaccepted draft is not part of the report. */
const declined = new Set();

/**
 * One slot, as it stands right now.
 *
 * On the published site a slot is its text or it is nothing — no prompt, no empty box,
 * no spacing where a box would have been, which is what keeps a report with no prose
 * identical to the report before any of this existed. In the workspace the owner sees
 * the prompt and the draft instead.
 */
export function proseSlot(slot, story, { owner, draft = null }) {
  const text = introOf(story, slot);
  const cls = slot === 'page' ? 'prose prose-lede' : 'prose';
  if (!owner) return text ? `<div class="${cls}">${paragraphs(text)}</div>` : '';

  if (text) {
    return `<div class="${cls}" data-prose="${slot}">
      <div class="prose-body" data-act="prose-edit" role="button" tabindex="0"
        aria-label="Edit: ${esc(PROMPTS[slot])}">${paragraphs(text)}</div>
    </div>`;
  }
  const offer = draft && !declined.has(slot)
    ? `<div class="prose-draft">
        <q>${esc(draft)}</q>
        <button type="button" class="link" data-act="prose-use">Use this</button>
        <button type="button" class="link quiet" data-act="prose-skip">Dismiss</button>
      </div>`
    : '';
  return `<div class="${cls} prose-empty" data-prose="${slot}">
    <button type="button" class="prose-prompt" data-act="prose-edit">${esc(PROMPTS[slot])}</button>
    ${offer}
  </div>`;
}

/* ------------------------------------------------------------------ editing */

/**
 * Click the prompt, type, click away. There is no edit mode and no Save button: the
 * slot becomes a textarea in place, autosaves as you type through the same debounced
 * write every other edit here uses, and turns back into text on blur. Escape puts back
 * what was there when you started.
 *
 * `save` is passed in rather than imported so this module stays out of the store: it
 * edits the story it is handed and nothing else.
 */
export function wireProse(root, { story, drafts, save }) {
  const slotEl = (slot) => root.querySelector(`[data-prose="${slot}"]`);

  // A slot is redrawn in place, whether it just filled, emptied or only changed. Nothing
  // else on the page depends on it — the share card follows the save, not the page — and
  // redrawing the whole dashboard for one sentence lost your place: charts drawn after
  // the page is measured leave it briefly short, and the browser clamps the scroll.
  const repaint = (slot) => {
    const el = slotEl(slot);
    if (!el) return;
    el.outerHTML = proseSlot(slot, story, { owner: true, draft: drafts[slot] });
  };

  const edit = (slot, seed = null) => {
    const el = slotEl(slot);
    if (!el || el.querySelector('textarea')) return;
    const before = introOf(story, slot);
    const cap = capFor(slot);
    el.classList.remove('prose-empty');
    el.innerHTML = `<textarea class="prose-in" rows="2" aria-label="${esc(PROMPTS[slot])}"
      placeholder="${esc(PROMPTS[slot])}"></textarea><span class="prose-count" aria-live="off"></span>`;
    const input = el.querySelector('textarea');
    const count = el.querySelector('.prose-count');
    input.value = seed ?? before;

    const measure = () => {
      const n = input.value.trim().length;
      // Only worth a number once you are near the cap; a counter on an empty box is
      // an instruction to write to length.
      const near = n >= cap * 0.8;
      count.textContent = near ? `${n} / ${cap}` : '';
      count.classList.toggle('over', n > cap);
      input.style.height = 'auto';
      input.style.height = `${input.scrollHeight}px`;
    };
    measure();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    input.addEventListener('input', () => {
      setIntro(story, slot, input.value);
      save();
      measure();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setIntro(story, slot, before);
      save();
      input.value = before;
      input.blur();
    });
    input.addEventListener('blur', () => {
      setIntro(story, slot, input.value);
      save();
      repaint(slot);
    }, { once: true });
  };

  root.addEventListener('click', (e) => {
    const hit = e.target.closest('[data-act^="prose-"]');
    if (!hit) return;
    const slot = hit.closest('[data-prose]')?.dataset.prose;
    if (!slot) return;
    if (hit.dataset.act === 'prose-edit') edit(slot);
    if (hit.dataset.act === 'prose-use') edit(slot, drafts[slot]);
    if (hit.dataset.act === 'prose-skip') {
      declined.add(slot);
      repaint(slot);
    }
  });
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const hit = e.target.closest('.prose-body[data-act="prose-edit"]');
    if (!hit) return;
    e.preventDefault();
    edit(hit.closest('[data-prose]').dataset.prose);
  });
}
