import { test } from 'node:test';
import assert from 'node:assert';
import { loadFn } from './_load.mjs';

const project = loadFn('projectOntoRail');

// Synthetic chat: heights deliberately NOT proportional to any text length, which is the
// case the old character-weighted rail got wrong (.msg-clamp caps long messages at 200px).
const HEIGHTS = [64, 200, 88, 200, 41, 512, 200, 37, 120, 200];
const TRACK = 600, PAD = 4, VIEW = 700;
const TOPS = HEIGHTS.reduce((a, h) => (a.push(a[a.length - 1] + h), a), [0]);
const SH = TOPS.pop();

test('a dot sits where its message is: scrolling message i to the top of the viewport ' +
     'puts the thumb top exactly on dot i', () => {
  for (let i = 0; i < HEIGHTS.length; i++) {
    const dot = project(TOPS[i], HEIGHTS[i], SH, TRACK, PAD, 4, 1);
    const thumb = project(TOPS[i], VIEW, SH, TRACK, PAD, 8, 0);   // scrollTop === TOPS[i]
    assert.ok(Math.abs(dot.top - thumb.top) < 1e-9, `dot ${i} drifted from the thumb`);
  }
});

test('the rail is exactly one track tall — the last dot ends at the bottom, never past it', () => {
  const last = HEIGHTS.length - 1;
  const p = project(TOPS[last], HEIGHTS[last], SH, TRACK, PAD, 4, 1);
  assert.ok(p.top + p.height <= PAD + TRACK + 1e-9);
});

test('every dot stays clickable: a 1px message still gets SEG_MIN height', () => {
  assert.equal(project(0, 1, 100000, TRACK, PAD, 4, 1).height, 4);
});
