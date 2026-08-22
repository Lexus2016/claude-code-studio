// _fitEnginePaneFont has two callers with OPPOSITE needs, and conflating them is why a
// split window still looked collapsed after the pane-pinning fix shipped:
//
//   engine pane  — spawned WIDE (220 columns). Must only ever SHRINK; capping at the
//                  body font size is what keeps it readable.
//   split pane   — NARROW (measured live: 41 columns beside five agent-team panes).
//                  Must be allowed to GROW, or 41 columns render at body size inside a
//                  160-column box and the rest of the terminal stays black.
//
// The original helper clamped with Math.min(base, …) unconditionally, so it could not
// grow at all — the reason the visible symptom survived a fix that had genuinely
// stopped the underlying output corruption.
import { test } from 'node:test';
import assert from 'node:assert';
import { loadFn } from './_load.mjs';

// Minimal DOM the helper reads: a root with --msg-font, and an entry with a host width.
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '15.5' });
globalThis.document = { documentElement: {} };
const fit = loadFn('_fitEnginePaneFont');

const mkEntry = (cols, width) => ({
  term: { cols, options: { fontSize: 15.5 } },
  host: { clientWidth: width },
});

test('a wide engine pane shrinks below the body size', () => {
  const e = mkEntry(220, 1200);
  fit(e);                      // grow omitted -> engine-pane behaviour
  assert.ok(e.term.options.fontSize < 15.5, `expected a shrink, got ${e.term.options.fontSize}`);
});

test('a wide pane is NOT grown even when asked to', () => {
  // grow raises the ceiling; it must never force an increase that does not fit.
  const e = mkEntry(220, 1200);
  fit(e, true);
  assert.ok(e.term.options.fontSize < 15.5);
});

test('a narrow split pane grows to fill the width', () => {
  // The live case: 41 columns in a ~1600px terminal.
  const e = mkEntry(41, 1600);
  fit(e, true);
  assert.ok(e.term.options.fontSize > 15.5,
    `a 41-column pane in 1600px must grow past the body size, got ${e.term.options.fontSize}`);
});

test('the same narrow pane is left alone without grow — the old behaviour', () => {
  // Pins the regression itself: this is exactly what the user kept seeing.
  const e = mkEntry(41, 1600);
  fit(e);
  assert.strictEqual(e.term.options.fontSize, 15.5);
});

test('growth is bounded so an absurdly narrow pane stays readable', () => {
  const e = mkEntry(5, 2000);
  fit(e, true);
  assert.ok(e.term.options.fontSize <= 30, `font ran away to ${e.term.options.fontSize}`);
});

test('a zero-width host is a no-op, not a division by zero', () => {
  const e = mkEntry(41, 0);
  fit(e, true);
  assert.strictEqual(e.term.options.fontSize, 15.5);
});
