# Chat Message Visual Hierarchy — Design

> Date: 2026-06-18 · Status: Approved (brainstorm) · Topic: chat message rendering
> Project: Claude Code Studio · Surface: `public/index.html` (renderMd/renderStreaming + CSS)

## Problem

Assistant messages render as flat prose — every line carries equal visual weight, so
the reader cannot glance at what matters (status, key result, warnings) and skim the
rest. The user wants a **scannable hierarchy**: important things caught at a glance,
descriptive text presented calmly but still nicely.

## Principles

1. **Hierarchy comes from explicit structure, not guessing.** The renderer styles
   structure the model already writes (status line, headers, bold, code, blockquotes,
   links). It does **not** parse prose to guess "importance" and auto-color it.
   Rationale: that heuristic class already caused two shipped bugs this session
   (sentence gluing, false numbered lists). Highlight only what is explicitly marked.
2. **Progressive disclosure: glance → read.** Top of a message surfaces status + key
   takeaway + facts. Body text is muted and calm so it never competes with the signal.
3. **Reuse the existing design tokens.** No new palette — the app already defines
   `--green / --orange / --red / --blue / --accent / --muted / --text / --code-bg` etc.
4. **Safe-by-default.** Plain prose with none of the conventions renders exactly as
   today. Rich accents appear only where a convention is explicitly present.
5. **Every new parser is verified.** Each heuristic (admonitions, status promotion,
   bare-URL autolink) ships with node unit-tests, like the prior two fixes.

## Element Vocabulary

| Element | Visual treatment | Trigger (explicit markup) |
|---|---|---|
| **Status badge** | colored pill: ✓ done (green), ❓ waiting (blue), ⚠ warn (amber), ✗ error (red), ⏳ running (violet) | the status line already written: `--- \n ✅ Done — …` / `❓ …` / `⚠️ …`. Renderer lifts it into a pill. |
| **Headline** | larger (≈19px), heavy (800), bright `--text` | first `#`/`##` heading OR first bold line of the message |
| **Fact chips** | mono, small, boxed (`--s3` bg, `--border`) | inline code in a short "meta" line (e.g. `` `commit 6ad6928` `` `` `9/10` ``) |
| **Section label** | 10.5px uppercase, letter-spaced, muted, with hairline rule | existing `##`/`###` headers, restyled |
| **Callout (admonition)** | left-border + tinted bg + uppercase title; 4 kinds: success (green), info (blue), warn (amber), danger (red) | GitHub-style `> [!NOTE]` `> [!TIP]` `> [!IMPORTANT]` `> [!WARNING]` `> [!CAUTION]`; plus emoji-led blockquotes (`> ✅ …`, `> ⚠️ …`) |
| **Key–value facts** | 2-col grid, muted key / bright value | a tight run of `**Key:** value` lines, OR a definition-style block |
| **Code block** | existing pre+header+lang+copy (keep as is) | fenced ``` blocks |
| **Table** | existing styled table (keep) | markdown pipe tables |
| **Body** | 14px, line-height ~1.72, muted `--muted`/`#aebbd4` | normal paragraphs |
| **Link — inline** | `--blue`, thin underline, ↗ affordance; opens new tab | markdown `[text](url)` **and** bare `http(s)://…` autolinked |
| **Link — button** | boxed accent chip with icon + ↗; touch-friendly | a standalone link on its own line / list item |

## Link Behavior (accepted: both styles, by context)

- **Inline** style for links inside a sentence; **button** style for standalone
  "open this" actions (own line / list item). Renderer picks by context.
- `target="_blank" rel="noopener noreferrer"` → opens an external/new browser tab.
  Covers desktop-wrapper case too (wrappers route `_blank` to the system browser).
- **Safe schemes only**: http, https, mailto (reuse existing `isSafeHref`).
- **Bare-URL autolink**: convert raw `https://…` into links. MUST avoid the heuristic
  traps: do not relink inside existing `<a>`/markdown links or code spans; strip
  trailing punctuation (`. , ; : ) ]`); balance parentheses in the URL. Ships with tests.
- **↗ affordance**: small external-link glyph so users know it leaves the chat.

## Scope

- Applies to all assistant messages, live streaming and DB-reloaded.
- User messages unchanged.
- Rich accents are opt-in via the conventions above; absent conventions → today's look.

## Implementation Surface

- `public/index.html` only (no build step — vanilla CSS + JS, single file). 
  - `renderMd()` / `renderStreaming()`: add status-line promotion, admonition parsing,
    bare-URL autolink. Order matters (protect code/inline-code first, as today).
  - CSS: add `.msg`-scoped classes for pill / headline / meta-chip / label / callout /
    kv / link-inline / link-button, all using existing CSS variables.
- No changes to the WebSocket contract, SQLite schema, or `claude-cli.js`.

## Robustness & Testing

- Each new transform gets a node unit-test (paren URLs, trailing punctuation,
  already-linked URLs, code spans, multiple admonitions, status line variants,
  message with none of the conventions = unchanged).
- Must not regress existing markdown (headers, lists, tables, code, blockquotes,
  the `(1)(2)(3)` inline-enumeration fix, the `\n\n` block-separator behavior).

## Out of Scope (deliberate)

- Auto-deriving headline/chips from raw prose (violates Principle 1).
- Opening `file:line` references in an editor (no editor integration here).
- Telegram bot rendering (separate surface).

## Open Implementation Notes

- Status-line promotion should keep the textual status line too, or replace it with the
  pill — decide during planning (lean: replace the `--- ✅ …` block with a top/bottom pill).
- Admonition parsing runs before generic blockquote handling so `> [!WARNING]` isn't
  consumed as a plain quote.
