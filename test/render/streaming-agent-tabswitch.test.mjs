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

// ── catchUp replay (WS reconnect on tab return) never carries `agent` ──────────
//
// loadSess() restores streaming.agent from the tab's saved curAgent BEFORE the socket
// reconnects. The reconnect's subscribe_session then triggers a server-side catchUp
// replay (server.js ~line 11516: `{type:'text', text: chatBuf, catchUp:true}`, no
// `agent` field) of everything buffered for that session. Read literally by
// _maybeFinalizeAgentSwitch, an absent d.agent looks like "speaker changed to none"
// and finalizes the just-restored bubble — reproducing the exact symptom this file
// guards against, one step later than the first scenario above.
const _isCatchUpNoAgent = loadFn('_isCatchUpNoAgent');
globalThis._isCatchUpNoAgent = _isCatchUpNoAgent;

assert.strictEqual(_isCatchUpNoAgent({ catchUp: true, agent: undefined }), true,
  'a catchUp packet with no agent must be recognized as such');
assert.strictEqual(_isCatchUpNoAgent({ catchUp: true, agent: 'bipa' }), false,
  'a catchUp packet that DOES carry an agent is not this case');
assert.strictEqual(_isCatchUpNoAgent({ catchUp: false, agent: undefined }), false,
  'a live (non-catchUp) chunk with no agent is a real "no speaker" state, not this case');

// Tab A: loadSess() just restored the bubble and streaming.agent = 'bipa' for the bot's
// still-running turn. The reconnect's catchUp packet for tab A arrives right after.
globalThis.activeTabId = 'A';
const elRestored = fakeEl();
streaming.el = elRestored;
streaming.txt = 'restored partial answer';
streaming.agent = 'bipa';

// Exercise the actual production sequence (index.html's visible 'text' branch calls
// _applyAgentSwitch with an ensureBubble callback; here streaming.el is already set,
// so there's no bubble to create).
globalThis._maybeFinalizeAgentSwitch = _maybeFinalizeAgentSwitch;
const _applyAgentSwitch = loadFn('_applyAgentSwitch');
const catchUpPacket = { agent: undefined, tabId: 'A', catchUp: true, text: 'restored partial answer' };
_applyAgentSwitch(catchUpPacket, null);

assert.strictEqual(streaming.el, elRestored,
  'a catchUp replay with no agent must not finalize the bubble loadSess just restored');
assert.strictEqual(streaming.agent, 'bipa',
  'a catchUp replay with no agent must not clobber the restored speaker to null');

console.log('PASS streaming-agent-tabswitch');
