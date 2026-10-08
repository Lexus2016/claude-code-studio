// Self-test for _load.mjs, the harness every other render test depends on: it extracts
// a function body out of public/index.html by finding its closing brace at column 0.
// If loadFn silently returned the wrong slice, every suite here would test the wrong
// code while still passing.
//
// This file used to be named `_load.selftest.mjs`, which does NOT match the
// `test/render/*.test.mjs` glob in package.json — so it never ran. The allowlist
// matrix below exercises the extracted callable and owns the URL cases.
import { test } from 'node:test';
import assert from 'node:assert';
import { loadFn } from './_load.mjs';

test('the allowlist covers the schemes the renderer actually emits', () => {
  const isSafeHref = loadFn('isSafeHref');
  for (const ok of ['http://x.com', 'https://x.com', 'mailto:a@b.c', 'tel:+15551234', '/rel', './rel', '../rel', '#anchor']) {
    assert.strictEqual(isSafeHref(ok), true, `${ok} should be allowed`);
  }
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,<script>alert(1)</script>']) {
    assert.strictEqual(isSafeHref(bad), false, `${bad} should be rejected`);
  }
});

test('loadFn throws loudly on a name that is not in index.html', () => {
  // A silent miss would be worse than a crash: the caller would get undefined and
  // every assertion against it would be vacuous.
  assert.throws(() => loadFn('thisFunctionDoesNotExist'), /not found in index\.html/);
});
