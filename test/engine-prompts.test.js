// GitHub #130, the part left open by PR #143 — "after a full page reload, a pending
// `input_needed` banner is not re-sent".
//
// The subscription engine announces a blocking TUI prompt once and withdraws it once.
// A page reloaded in between gets a new socket that saw neither frame and a fresh tab
// state with nothing to redraw the banner from: the chat shows a running turn and no
// question. engine-prompts.js keeps the open prompt per session; server.js feeds it
// from the engine's onPromptState callback and replays it on subscribe_session.
//
// The store is driven directly. The wiring lives in server.js, which cannot be
// required, so it is pinned as source text: every runInteractiveSingle call site must
// feed the store (a missed one is a path whose prompts are never replayed), and the
// replay must stay behind !noCatchUp and isSessionLive. The engine side (onPromptState
// fires on both edges) is exercised against a live pane in claude-firstrun.test.js.
//
// Run: node test/engine-prompts.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createEnginePromptStore } = require('../engine-prompts');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const PROMPT = { type: 'input_needed', sessionId: 's1', engine: 'subscription', prompt: '❯ 1. Yes\n  2. No' };

console.log('\n── the store');
{
  const st = createEnginePromptStore();
  check('nothing open replays nothing', st.replay('s1', true), null);
  st.track('s1', PROMPT);
  check('an open prompt is replayed to a live session, addressed to its tab',
    st.replay('s1', true), { ...PROMPT, tabId: 's1', replayed: true });
  check('replaying does not consume it (the tab may be reopened again)', st.replay('s1', true) !== null, true);
  check('the frame the engine tagged with a tab keeps that tab',
    (st.track('s2', { ...PROMPT, sessionId: 's2', tabId: 'tab-x' }), st.replay('s2', true).tabId), 'tab-x');
  st.track('s1', null);
  check('the answered edge (null) closes it', st.replay('s1', true), null);
  st.track('s3', PROMPT);
  st.track('s3', { type: 'input_resolved', sessionId: 's3' });
  check('an input_resolved frame closes it too', st.replay('s3', true), null);
  st.track('s4', PROMPT);
  check('a prompt whose turn is no longer live is not replayed', st.replay('s4', false), null);
  check('...and is dropped, not kept for the next live turn', st.replay('s4', true), null);
  st.track('', PROMPT);
  check('no session id, nothing stored', st.size(), 1);   // only s2 is left open
}

console.log('\n── the wiring in server.js');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const calls = [...src.matchAll(/await runInteractiveSingle\(\{/g)].map(m => m.index);
check('three engine call sites (chat, Kanban task, Telegram)', calls.length, 3);
for (const at of calls) {
  // The options object of each call: up to its closing "});" at the call's indentation.
  const body = src.slice(at, src.indexOf('\n', src.indexOf('});', at)));
  const line = src.slice(0, at).split('\n').length;
  check(`server.js:${line} feeds the prompt store`, /onPromptState:\s*\(f\)\s*=>\s*enginePrompts\.track\(/.test(body), true);
}
const sub = src.indexOf("if (msg.type === 'subscribe_session')");
const subEnd = src.indexOf("if (msg.type === 'dispatch_plan')", sub);
const handler = src.slice(sub, subEnd);
const replayAt = handler.indexOf('enginePrompts.replay(');
check('subscribe_session replays an open prompt', replayAt >= 0, true);
const guard = handler.lastIndexOf('if (', replayAt);
check('...only for a foreground subscribe (not noCatchUp)', /!noCatchUp/.test(handler.slice(guard, replayAt)), true);
check('...and only while the session is live', /enginePrompts\.replay\(sessionId,\s*isSessionLive\(sessionId\)\)/.test(handler), true);

const eng = fs.readFileSync(path.join(__dirname, '..', 'claude-interactive.js'), 'utf8');
const sendAll = eng.slice(eng.indexOf('const wsSendAll = (obj) => {'), eng.indexOf('};', eng.indexOf('const wsSendAll = (obj) => {')));
check('the engine reports both prompt edges through onPromptState',
  /onPromptState\(obj\.type === 'input_needed' \?/.test(sendAll), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
