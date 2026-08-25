// tmux-composite.js — build ONE terminal frame out of a SPLIT tmux window.
//
// Why this exists. tmux control mode (`tmux -C attach-session`) is not a renderer: it
// hands the client `%output %<pane-id> <bytes>` per pane and leaves composition to
// whoever is drawing. A real tmux client composes; we were not. terminal-bridge.js
// therefore picked ONE pane, dropped every other pane's bytes on the floor, and told
// the browser to shrink its xterm to that pane — which is what the user saw: Claude
// Code's agent-teams splits the window (measured on a live session: window 155x39,
// the user's own `claude` squeezed into 46x38 on the left, four teammates at 108x9
// stacked on the right), and the studio showed the 46-column strip and nothing else.
//
// The pane bytes cannot simply be merged: every pane addresses cursor positions that
// are LOCAL to itself, so four TUIs writing into one screen buffer scribble over each
// other. Composing means knowing where each pane sits and re-addressing its content —
// which is what buildFrame() does, from `capture-pane` snapshots rather than from the
// raw streams (a stream cannot be re-addressed without a full terminal emulator per
// pane).
//
// Everything here is pure: no tmux, no processes, no I/O. terminal-bridge.js supplies
// the captures and writes the bytes.

// tmux counts from 0, ANSI CUP from 1.
const cup = (row, col) => `\x1b[${row + 1};${col + 1}H`;
const RESET = '\x1b[0m';

// `list-panes -F PANE_FORMAT` → the layout this module works in.
// pane_title is what agent-teams names its teammates ("correctness", "tests", …) and
// is the only place that name exists — the TUI inside the pane never prints it.
const PANE_FORMAT = '#{pane_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{pane_active}|#{pane_index}|#{pane_dead}|#{pane_title}';

// Deliberately tolerant: a pane title may contain `|`, so the title takes everything
// after the 8th field instead of being split out of it. A row that does not parse is
// dropped rather than allowed to poison the layout with NaN geometry — a pane at
// column NaN would blank the whole frame.
function parsePaneList(lines) {
  const out = [];
  for (const raw of lines) {
    const line = String(raw).replace(/\r$/, '');
    if (!line) continue;
    const f = line.split('|');
    if (f.length < 8) continue;
    const [id, left, top, cols, rows, active, index, dead] = f;
    const p = {
      id,
      left: parseInt(left, 10), top: parseInt(top, 10),
      cols: parseInt(cols, 10), rows: parseInt(rows, 10),
      active: active === '1', index: parseInt(index, 10), dead: dead === '1',
      title: f.slice(8).join('|'),
    };
    if (!/^%\d+$/.test(p.id)) continue;
    if (![p.left, p.top, p.cols, p.rows].every(Number.isFinite)) continue;
    if (p.cols <= 0 || p.rows <= 0) continue;
    out.push(p);
  }
  return out;
}

// The pane a viewer represents when it is NOT compositing, and the pane that owns the
// conversation when it is.
//
// It is pane_index 0, never the ACTIVE pane, and that distinction is the whole bug on
// the reconnect path: splitting a window makes the NEW pane active, so a viewer that
// re-attached after any socket drop (server restart, idle proxy timeout, a laptop
// waking) re-pinned itself to whichever teammate agent-teams had spawned last and the
// user's own agent vanished from a terminal that had been showing it a second earlier.
// pane_index 0 is the pane ensureSession created, and it stays 0 across every split.
function primaryPane(panes) {
  if (!panes.length) return null;
  let best = panes[0];
  for (const p of panes) if (p.index < best.index) best = p;
  return best;
}

// Pad a capture row out to the pane width so the row can be cleared without touching
// the neighbouring pane. `capture-pane -N` was the obvious way to get tmux to do this
// and it does NOT: measured on tmux 3.7c, a 2-character row in a 60-column pane comes
// back padded to 15. So the frame writes `width` spaces at the pane's origin and then
// re-homes and writes the content — exact regardless of how wide the glyphs are, which
// matters because `\x1b[K` (erase to end of LINE) would wipe every pane to the right.
function clearRun(width) { return ' '.repeat(Math.max(0, width)); }

// One pane's rows, re-addressed into window coordinates.
//
// `prev` is the rows this pane was last drawn with; a row equal to its predecessor is
// skipped. A Claude TUI repaints its whole frame for a spinner tick, so without the
// diff every pane would re-send ~6 KB several times a second per teammate.
function paneRows(pane, capture, prev, full) {
  let out = '';
  const next = new Array(pane.rows);
  for (let r = 0; r < pane.rows; r++) {
    const line = capture[r] === undefined ? '' : capture[r];
    next[r] = line;
    if (!full && prev && prev[r] === line) continue;
    out += cup(pane.top + r, pane.left) + RESET + clearRun(pane.cols)
         + cup(pane.top + r, pane.left) + line + RESET;
  }
  return { out, next };
}

// tmux draws pane borders itself, client-side — control mode carries not one byte of
// them. Without this a composed frame is four TUIs butted against each other with no
// seam, and the agent-teams window (which sets `pane-border-status top`, so every pane
// has a titled border row above it) loses the teammate names entirely.
//
// A pane's own borders are the column to its LEFT and the row ABOVE it, which is how
// tmux lays them out — so the cell where the two meet belongs to neither pane and has
// to be worked out from what the vertical run does above and below it. Skipping that
// leaves a one-cell hole at every T-junction, which reads as a broken frame rather
// than as a seam.
function borders(panes, win) {
  const vertical = new Map();          // col → Set(rows the vertical run occupies)
  for (const p of panes) {
    if (p.left <= 0) continue;
    const col = p.left - 1;
    if (!vertical.has(col)) vertical.set(col, new Set());
    const rows = vertical.get(col);
    for (let r = p.top; r < p.top + p.rows && r < win.rows; r++) rows.add(r);
  }
  const junction = (col, row) => {
    const rows = vertical.get(col);
    if (!rows) return '─';
    const up = rows.has(row - 1), down = rows.has(row + 1);
    return up && down ? '├' : down ? '┬' : up ? '┴' : '─';
  };

  let out = '';
  for (const p of panes) {
    const colour = p.active ? '\x1b[38;5;110m' : '\x1b[38;5;240m';
    if (p.left > 0) {
      const col = p.left - 1;
      for (let r = p.top; r < p.top + p.rows && r < win.rows; r++) out += cup(r, col) + colour + '│' + RESET;
    }
    if (p.top > 0) {
      const row = p.top - 1;
      // The title sits at the left of the border the way tmux's default
      // pane-border-format reads, and is truncated rather than allowed to run into the
      // pane next door.
      const label = p.title ? ` ${p.title} ` : '';
      const text = (label.length + 2 <= p.cols) ? '─' + label : '';
      const fill = '─'.repeat(Math.max(0, p.cols - text.length));
      out += cup(row, p.left) + colour + (text + fill).slice(0, p.cols) + RESET;
      if (p.left > 0) out += cup(row, p.left - 1) + colour + junction(p.left - 1, row) + RESET;
      const right = p.left + p.cols;
      if (right < win.cols) out += cup(row, right) + colour + junction(right, row) + RESET;
    }
  }
  return out;
}

// The whole frame.
//
// `full` clears the screen first and redraws every row; it is for entering composite
// mode and for a layout change, where the previous picture describes a window that no
// longer exists. Otherwise only the panes in `captures` are touched, and only their
// changed rows.
//
// The cursor goes last and is placed in WINDOW coordinates — a pane reports its cursor
// relative to itself, so a teammate's cursor at 0,0 would otherwise land in the corner
// of the screen and drag the user's caret out of the pane they are typing into.
function buildFrame({ panes, win, captures, prev, cursor, full = false }) {
  const seen = new Map();
  let out = full ? '\x1b[H\x1b[2J' : '';
  if (full) out += borders(panes, win);
  for (const p of panes) {
    const cap = captures instanceof Map ? captures.get(p.id) : (captures || {})[p.id];
    if (!cap) { const keep = prev && prev.get(p.id); if (keep) seen.set(p.id, keep); continue; }
    const before = full ? null : (prev && prev.get(p.id));
    const { out: rows, next } = paneRows(p, cap, before, full);
    out += rows;
    seen.set(p.id, next);
  }
  if (cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y)) {
    const host = panes.find(p => p.id === cursor.pane) || panes.find(p => p.active);
    if (host) {
      out += cup(host.top + cursor.y, host.left + cursor.x);
      out += cursor.visible === false ? '\x1b[?25l' : '\x1b[?25h';
    }
  }
  return { data: out, prev: seen };
}

module.exports = { PANE_FORMAT, parsePaneList, primaryPane, buildFrame, borders, paneRows, cup };
