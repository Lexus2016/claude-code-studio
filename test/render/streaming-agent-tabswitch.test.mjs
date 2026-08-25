import assert from 'node:assert';
import { loadFn, loadConst } from './_load.mjs';

// Regression for the "bot bubble vanishes, an unfamiliar bubble takes its place,
// then a fresh bubble appears below with the bot's continued work" report.
//
// `streaming` (const, index.html ~line 4392) proxies `el`/`txt`/`toolCounts`/`toolLog`
// through `getTS(activeTabId)` so each open chat tab keeps its own live-streaming
// state — exactly the same pattern the `bots_turn` handler documents in a comment at
// index.html ~line 7487: "Persisted per-tab ... so a background tab's turn never
// leaks into [the UI of] a DIFFERENT tab". `streaming.agent`, read by
// `_maybeFinalizeAgentSwitch` to detect a change of speaker in a multi-bot
// "conversation room", was the one property that DIDN'T follow that rule — it lived
// as a bare own-property on the single shared `streaming` object, so switching tabs
// clobbered it for every tab.
//
// Sequence this reproduces: bot "bipa" is mid-turn in tab A. User switches to tab B
// (any activity there — including a different bot speaking — overwrites the shared
// `streaming.agent`). User switches back to tab A while "bipa" is still talking. The
// next chunk for "bipa" in tab A must NOT look like a speaker change.

globalThis.tabState = {};
globalThis.activeTabId = 'A';
const getTS = loadFn('getTS');
globalThis.getTS = getTS;

// _maybeFinalizeAgentSwitch's finalize branch touches these — stub as inert.
globalThis.renderMd = (x) => x;
globalThis._finalizeToolLive = () => {};
globalThis._msfStopTimer = () => {};
globalThis._msfRemove = () => {};
globalThis._cancelStreamRender = loadFn('_cancelStreamRender');
globalThis._botsById = { bipa: { id: 'bipa', label: 'Bipa-Product' }, olya: { id: 'olya', label: 'Оля-lead' } };
globalThis._deletedBotIds = new Set();

// _maybeFinalizeAgentSwitch is materialized via `new Function`, which resolves free
// identifiers against globalThis, not this module's scope — `streaming` must live there.
const streaming = loadConst('streaming');
globalThis.streaming = streaming;
const _maybeFinalizeAgentSwitch = loadFn('_maybeFinalizeAgentSwitch');

function fakeEl() {
  const msgDiv = { innerHTML: '' };
  return { querySelector: (sel) => (sel === '.msg' ? msgDiv : null) };
}

// Tab A: bot "bipa" starts talking.
globalThis.activeTabId = 'A';
const elA = fakeEl();
streaming.el = elA;
streaming.txt = 'partial answer so far';
streaming.agent = 'bipa';

// User switches to tab B, where a DIFFERENT bot ("olya") is speaking.
globalThis.activeTabId = 'B';
streaming.el = fakeEl();
streaming.agent = 'olya';

// User switches back to tab A. "bipa" sends another chunk, continuing the SAME turn.
globalThis.activeTabId = 'A';
_maybeFinalizeAgentSwitch({ agent: 'bipa', tabId: 'A' });

assert.strictEqual(streaming.el, elA,
  'same bot continuing in tab A must not be finalized just because tab B saw a different speaker');
assert.strictEqual(streaming.txt, 'partial answer so far',
  'tab A\'s accumulated text must survive the return from tab B');

// Sanity check the mechanism actually still catches a REAL same-tab speaker change.
globalThis.activeTabId = 'A';
streaming.el = elA;
streaming.agent = 'bipa';
_maybeFinalizeAgentSwitch({ agent: 'olya', tabId: 'A' });
assert.strictEqual(streaming.el, null, 'a genuine same-tab speaker change must still finalize the bubble');

console.log('PASS streaming-agent-tabswitch');
