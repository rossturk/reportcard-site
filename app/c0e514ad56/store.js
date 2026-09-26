import { emptyStory, normalizeStory } from './model.js';

/**
 * `static` is the exported site: the same app, reading data baked into the page instead
 * of a server. Every write path checks it, because there is nothing behind the site to
 * write to — a published report is a finished thing, not a workspace.
 */
export const state = {
  auth: null, data: null, story: emptyStory(), job: null,
  static: Boolean(globalThis.__REPORTCARD__),
};

const listeners = new Set();
export const subscribe = (fn) => listeners.add(fn);
const emit = (reason) => listeners.forEach((fn) => fn(reason));

export async function load() {
  if (state.static) {
    const baked = globalThis.__REPORTCARD__;
    // Nothing to authorise: the pull already happened on the machine that exported this.
    state.auth = { ok: true };
    state.data = baked.data;
    state.story = normalizeStory(baked.story);
    return;
  }
  const payload = await (await fetch('/api/state')).json();
  state.auth = payload.auth;
  state.data = payload.data;
  state.story = normalizeStory(payload.story);
  state.job = payload.job;
  if (state.job?.state === 'running') poll();
}

let saveTimer = null;
/**
 * Persist the story — the whole of it, to the workspace, over HTTP.
 *
 * Not localStorage, which is what the name suggests and what a reader guessed. Your
 * curation lives in story.json in a directory you own and can commit; the browser holds
 * no copy of record. Every edit calls this, so it debounces: typing a project's
 * description is one write 400ms after the last keystroke, not one per character. It
 * sends state.story entire rather than a patch, which is what makes it safe to call
 * from anywhere that has just mutated it.
 *
 * On the exported site there is nothing behind the page to write to, and it returns.
 */
export function save() {
  if (state.static) return;
  setFlag('saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const res = await fetch('/api/story', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(state.story),
      });
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      setFlag('saved');
      setTimeout(() => { if (document.getElementById('saveflag').textContent === 'saved') setFlag(''); }, 1500);
    } catch (e) {
      // A write that never landed must not look like one that did: this used to leave
      // "saving…" up forever while the edit existed only in the tab. Nothing is lost
      // yet — the next edit sends the whole story again, this one included — but the
      // person needs to know before they close the window.
      setFlag('not saved');
      toast(`Not saved — ${e.message || 'the server is unreachable'}. Keep this tab open.`);
    }
  }, 400);
}

export async function pull(from) {
  const res = await fetch('/api/pull', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from }),
  });
  const body = await res.json();
  if (!res.ok && res.status !== 409) {
    toast(body.error || 'Pull failed');
    return;
  }
  state.job = body.job;
  emit('job');
  poll();
}

function poll() {
  const tick = async () => {
    let job;
    let data;
    try {
      ({ job, data } = await (await fetch('/api/pull')).json());
    } catch {
      // The server went away mid-pull. Before this, the tick threw, polling stopped
      // without a word, and the pull row said "running" for as long as the tab was open.
      state.job = { state: 'error', message: 'lost contact with reportcard' };
      toast('Lost contact with the pull — is `reportcard run` still going?');
      emit('job');
      return;
    }
    state.job = job;
    if (job?.state === 'running') {
      emit('job');
      setTimeout(tick, 800);
      return;
    }
    if (job?.state === 'error') {
      toast(`Pull failed: ${job.message}`);
      emit('job');
      return;
    }
    if (data) {
      state.data = data;
      emit('data');
      toast(`Pulled ${data.projects.length} repos`);
    }
  };
  tick();
}

function setFlag(text) {
  document.getElementById('saveflag').textContent = text;
}

let toastTimer = null;
/**
 * A brief message, optionally with a way back.
 *
 * `action` is for edits that destroy something without asking first: an undo offered in
 * the moment beats a confirmation dialog on every click, and beats discovering days later
 * that a merge lost a repo.
 */
export function toast(message, action = null) {
  const el = document.getElementById('toast');
  el.textContent = '';
  // A space before the button, so the announced string doesn't run the message into the
  // label ("Split out of websiteUndo").
  el.append(action ? `${message} ` : message);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-undo';
    btn.textContent = action.label || 'Undo';
    btn.setAttribute('aria-label', `${action.label || 'Undo'}: ${message}`);
    btn.addEventListener('click', () => {
      el.classList.remove('on');
      clearTimeout(toastTimer);
      action.run();
    }, { once: true });
    el.append(btn);
  }
  el.classList.add('on');
  clearTimeout(toastTimer);
  // Long enough to read and reach, without parking over the page.
  toastTimer = setTimeout(() => el.classList.remove('on'), action ? 7000 : 2200);
}

const tipEl = () => document.getElementById('tip');

export function showTip(html, x, y) {
  const tip = tipEl();
  tip.innerHTML = html;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
  tip.classList.add('on');
}

export const hideTip = () => tipEl().classList.remove('on');

/** Plain `data-tip` tooltips for anything under root. Elements marked `data-tip-custom` run their own. */
export function bindTips(root) {
  root.addEventListener('mousemove', (e) => {
    if (e.target.closest('[data-tip-custom]')) return;
    const el = e.target.closest('[data-tip]');
    if (!el) return hideTip();
    const tip = tipEl();
    tip.textContent = el.dataset.tip;
    tip.style.left = `${e.clientX}px`;
    tip.style.top = `${e.clientY - 8}px`;
    tip.classList.add('on');
  });
  root.addEventListener('mouseleave', hideTip);
}
