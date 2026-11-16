'use strict';
// The prompt a subscription-engine turn is blocked on, remembered per session (#130).
//
// The engine announces a blocking TUI prompt ONCE (`input_needed`) and withdraws it
// once (`input_resolved`). A browser that reloads while the turn waits gets a new
// socket that saw neither frame and a fresh tab state with nothing to redraw the
// banner from — so the chat shows a running turn and no question. The server is the
// only party that outlives the page, so it keeps the open prompt and hands it to the
// next subscriber.
//
// Pure: no sockets, no SQLite. server.js decides when a session is live and who gets
// the frame; this only answers "what is open right now".

function createEnginePromptStore() {
  const open = new Map(); // sessionId -> the input_needed frame, as the engine sent it
  // sessionId -> keys answered from a button (#131). Kept across input_resolved, which
  // the engine also sends for a TRANSIENT blip (a transcript write, one poll where the
  // pane did not qualify) before announcing the very same question again. Forgotten
  // when the turn is seen dead; bounded so a long turn cannot grow it without limit.
  // Cost of the bound and of keeping keys for a live session: an IDENTICAL question
  // asked again later gets "Open pane" only, never a button that answers it twice.
  const consumed = new Map();
  const CONSUMED_MAX = 32;
  const strip = (frame) => { const { options, promptKey, ...rest } = frame; return rest; };

  return {
    // Fed by runInteractiveSingle's onPromptState: a frame while a prompt is open,
    // null when it is answered or the turn ends (the engine's finally sends that edge
    // on every exit path).
    // Returns the frame it kept — without options when the key was already answered —
    // so the engine sends exactly what a reload would replay.
    // `meta.turnEnded` comes once, from the engine's finally: the only edge that may
    // forget the turn's answered keys.
    track(sessionId, frame, meta) {
      if (!sessionId) return null;
      if (meta && meta.turnEnded) consumed.delete(sessionId);
      if (!frame || frame.type !== 'input_needed') { open.delete(sessionId); return null; }
      const spent = frame.promptKey && consumed.get(sessionId)?.has(frame.promptKey);
      const kept = spent ? strip(frame) : frame;
      open.set(sessionId, kept);
      return kept;
    },
    // The frame to replay to a subscriber, or null. A prompt is only worth replaying
    // while its turn is alive: an entry that outlived its turn (a crash between the
    // two edges) is dropped here instead of showing a question nobody is asking.
    replay(sessionId, isLive) {
      const frame = this.current(sessionId, isLive);
      return frame && { ...frame, tabId: frame.tabId || sessionId, replayed: true };
    },
    // The open prompt as the engine sent it, or null — same liveness rule as replay.
    // An answer (#131) is checked against this before the pane is even captured: a
    // button from a prompt the engine has withdrawn is refused without touching tmux.
    current(sessionId, isLive) {
      if (!isLive) { open.delete(sessionId); consumed.delete(sessionId); return null; }
      return open.get(sessionId) || null;
    },
    // An answer was typed into the pane for the prompt whose key is `promptKey`: that
    // prompt can never be answered from a button again. Its banner stays (the turn may
    // still be waiting — a text field, a checkbox), only the buttons go, so neither a
    // reload nor a second window can redraw them and type a digit into whatever the
    // pane shows next. A NEW question is announced by the engine as a new frame, with
    // its own key. Keyed so a frame announced meanwhile is never the one stripped.
    consume(sessionId, promptKey) {
      const frame = open.get(sessionId);
      if (!frame || !promptKey || frame.promptKey !== promptKey) return false;
      const keys = consumed.get(sessionId) || new Set();
      keys.add(promptKey);
      while (keys.size > CONSUMED_MAX) keys.delete(keys.values().next().value);
      consumed.set(sessionId, keys);
      open.set(sessionId, strip(frame));
      return true;
    },
    size() { return open.size; },
  };
}

module.exports = { createEnginePromptStore };
