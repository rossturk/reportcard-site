import { bindTips, load, state, subscribe } from './store.js';
import { readyForDashboard } from './model.js';
import { renderScope, updatePullRow } from './scope.js';
import { renderDashboard } from './dashboard.js';
import { inkInset } from './svg.js';

const app = document.getElementById('app');
const requested = () => (location.hash === '#dashboard' ? 'dashboard' : 'scope');

function go(step) {
  // The exported site is only ever the dashboard, so a step change is just a redraw.
  if (state.static) {
    if (step === 'dashboard') render();
    return;
  }
  if (location.hash === `#${step}`) render();
  else location.hash = step;
}

/**
 * Hang each title by its own left side bearing, the way the image export does.
 *
 * The display face holds its ink a few pixels inside the text origin — at 64px that is
 * enough to read as an indent against the body copy underneath, which is set at the same
 * x and barely inset at all. CSS cannot see a side bearing, so it is measured here and
 * spent as a negative margin. In em, so it keeps up with the heading's clamp() as the
 * window resizes, and per heading, because "Mar" and "Apr" do not need the same nudge.
 */
function hangTitles() {
  for (const h of app.querySelectorAll('h1')) {
    const style = getComputedStyle(h);
    // Only a heading that starts on the margin has a margin to line up with. Hanging a
    // centred one (the signed-out note) would just push it off centre.
    if (style.textAlign !== 'start' && style.textAlign !== 'left') continue;
    const size = parseFloat(style.fontSize);
    const inset = inkInset(h.textContent.trim(), { size, family: style.fontFamily });
    h.style.marginLeft = `${(-inset / size).toFixed(4)}em`;
  }
}

function render() {
  paint();
  hangTitles();
}

function paint() {
  // The site has no app bar, so anything the page pins has nothing to clear.
  document.body.classList.toggle('published', Boolean(state.static));
  if (state.static) return renderDashboard(app, go);

  const ready = readyForDashboard(state.data, state.story);
  let step = requested();
  if (step === 'dashboard' && !ready) {
    history.replaceState(null, '', '#scope');
    step = 'scope';
  }

  for (const link of document.querySelectorAll('.steps [data-step]')) {
    link.classList.toggle('on', link.dataset.step === step);
  }
  const dashLink = document.querySelector('.steps [data-step="dashboard"]');
  dashLink.setAttribute('aria-disabled', String(!ready));
  document.querySelector('.steps [data-step="scope"]').setAttribute('aria-current', step === 'scope' ? 'step' : 'false');
  dashLink.setAttribute('aria-current', step === 'dashboard' ? 'step' : 'false');

  if (!state.auth?.ok) {
    app.innerHTML = `<div class="page"><div class="center-note">
      <h1>GitHub CLI isn't signed in.</h1>
      <p class="lede">Report Card reads your history through <code>gh</code>, private repos included.
      Run <code>gh auth login</code> in a terminal, then reload.</p></div></div>`;
    return;
  }

  if (step === 'dashboard') renderDashboard(app, go);
  else renderScope(app, go);
}

window.addEventListener('hashchange', () => {
  render();
  window.scrollTo(0, 0);
});

subscribe((reason) => {
  // Progress ticks shouldn't rebuild the page out from under someone typing.
  if (reason === 'job' && requested() === 'scope') updatePullRow();
  else render();
});

bindTips(app);
await load();
render();
// The first measurement can land before the display face has arrived, and a fallback's
// bearings are not this one's. Measuring again once the fonts are in costs nothing.
document.fonts?.ready.then(hangTitles);
