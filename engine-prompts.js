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

  return {
    // Fed by runInteractiveSingle's onPromptState: a frame while a prompt is open,
    // null when it is answered or the turn ends (the engine's finally sends that edge
    // on every exit path).
    track(sessionId, frame) {
      if (!sessionId) return;
      if (frame && frame.type === 'input_needed') open.set(sessionId, frame);
      else open.delete(sessionId);
    },
    // The frame to replay to a subscriber, or null. A prompt is only worth replaying
    // while its turn is alive: an entry that outlived its turn (a crash between the
    // two edges) is dropped here instead of showing a question nobody is asking.
    replay(sessionId, isLive) {
      const frame = open.get(sessionId);
      if (!frame) return null;
      if (!isLive) { open.delete(sessionId); return null; }
      return { ...frame, tabId: frame.tabId || sessionId, replayed: true };
    },
    size() { return open.size; },
  };
}

module.exports = { createEnginePromptStore };
