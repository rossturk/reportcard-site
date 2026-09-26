// Colors and type shared by the on-screen charts and the canvas export.

export const PAPER = '#faf8f3';
export const CARD = '#ffffff';
export const INK = '#16150f';
export const INK2 = '#55524a';
export const INK3 = '#86817a';
export const RULE = '#e4dfd3';
export const RULE_STRONG = '#cdc6b6';
export const SUNK = '#f3f0e8';

/**
 * Graphite. One rule: the grey ramp says how much, tomato says what is live or matters
 * most. Tomato is allowed in exactly four places: Ongoing status, the dial's busiest arc,
 * this period's line, and release markers. Anywhere else it is a bug, and it is never a
 * ramp step: it marks a highlight, not a quantity. The title's handle used to be a fifth
 * place and is graphite now: a name is not a highlight.
 */
export const GRAPHITE = ['#ece7dc', '#d8d2c7', '#a69f93', '#625c54', '#1f1d1b']; // none → most
export const TOMATO = '#d2552f';

export const FONT = '"LINE Seed JP", system-ui, -apple-system, "Segoe UI", sans-serif';
export const MONO = '"Overpass Mono", ui-monospace, Menlo, monospace';
/**
 * Titles only. A display face earns its keep on one or two big strings and nowhere else;
 * it ships a single weight (400), so anything using it must not ask for bold — the
 * browser would synthesise one rather than load a weight that is not there.
 */
export const DISPLAY = '"Blinker", "LINE Seed JP", system-ui, sans-serif';

/**
 * Blend a colour toward the paper, for "same thing, but absent" states. Takes #rgb or
 * #rrggbb; the short form is expanded rather than read as garbage channels.
 */
export function tint(hex, amount = 0.62) {
  const mix = (a, b) => Math.round(a + (b - a) * amount);
  const full = hex.length === 4 ? `#${[1, 2, 3].map((i) => hex[i] + hex[i]).join('')}` : hex;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16));
  const [pr, pg, pb] = [1, 3, 5].map((i) => parseInt(PAPER.slice(i, i + 2), 16));
  return `#${[mix(r, pr), mix(g, pg), mix(b, pb)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// This period is the only coloured line; earlier ones recede, lighter the older they are.
export const CURRENT = TOMATO;
export const PREVIOUS = [GRAPHITE[2], '#c4beb3', GRAPHITE[1]];

/**
 * Type that survives whatever it is sitting on.
 *
 * The stacked bars label their own segments, and a segment's colour is data — it moves
 * with the ramp, with how many slices there are, and with which dimension is being
 * drawn. A single label ink is therefore a bet, and it was losing on the darkest
 * segments. This picks per segment the way WCAG measures it: relative luminance, then
 * whichever of ink and paper-white has the better contrast against it.
 */
const channel = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

export function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** Ink or white, whichever reads better on `hex`. */
export const labelInkOn = (hex) => (contrast(hex, INK) >= contrast(hex, '#ffffff') ? INK : '#ffffff');
