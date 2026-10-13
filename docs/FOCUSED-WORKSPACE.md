# Focused workspace and fast return

This change keeps the existing vanilla, single-file frontend and all execution paths. It introduces progressive disclosure and navigational state, not a new runtime or a reduced feature edition.

## Where features live

- Activity, Projects and Chats remain in the primary rail.
- **Tools & team** opens Bots, external Agents, MCP, Skills, Commands, SSH hosts, Remote Access and Telegram. Their existing controls, IDs and event handlers remain intact.
- **Run settings** exposes the existing mode, agent/team mode, model, engine, effort, maximum-turn and default controls. Its closed summary reflects the actual mode, team, model and engine. It does not alter execution defaults.
- **Files** opens the workspace rail when needed. Existing saved panel preferences are respected.
- **More** contains CLI import, configuration, language, GitHub and logout. Configuration and import return keyboard focus to the persistent menu trigger.
- Session recovery, stop, live pane, delegation, export, notes and terminal controls are not moved into the general settings menu.
- **Go to…** (Ctrl/Cmd+K) searches pages, tools and projects. The current project/chat and a Back button remain visible on desktop and mobile.
- Mobile gains Dashboard, CLI import and a synchronized effort control. Existing attachment, command, file, SSH and bot triggers remain available.

## Return behavior

Explicit chat/project selections create browser-history entries. Background renders and polling do not. Back/Forward restores the project/chat, sidebar filter and transcript reading position; the outgoing composer state is saved before leaving. Newer user navigation cancels older pending restoration. A closed unsent draft or terminal is not recreated as an ordinary chat from a stale history ID. Deleted projects are ignored safely.

Back dismisses open overlays and restores the previous workspace entry. Overlays do not create artificial history entries or trigger a second Back operation. Opening and closing a disclosure does not change browser history. Close/Escape returns focus to its persistent trigger.

The current entry follows the screen when it changes without a click — a message sent from a project's welcome screen opens a chat, a new chat becomes a session — so Forward returns to that chat rather than to the empty project. That sync is suspended before boot has read the entry, during a Back/Forward restore, and while a click is still being recorded. An entry pushed by a click opens at the bottom; only the entry being left keeps its reading position. A restore that starts during boot (reload, or Back across a page boundary) waits for the whole document, because it calls helpers from the last script block.

Kanban, Schedule and Dashboard restore project, search and scroll for **the same history entry** (Back, Forward, reload). A fresh visit follows the project chosen last in the chat or on these pages (`cc_ui_state`), as before; the tab's previous snapshot only supplies scroll and search when it belongs to that same project. Kanban also preserves board and column scroll positions during refresh. Explicit URL filters and session deep links take precedence over remembered state. Page departure saves the chat draft, attachments and reply selection through the existing persistence path.

Run settings closes on Escape and on a click outside it. Go to… opens with ⌘K on macOS and Ctrl+K elsewhere; on a Mac, Ctrl+K stays the text field's kill-to-end-of-line.

## Honest simplification measures

These are source/DOM structural counts against main commit `0e5f853e6efafe293954923993cea34bda3ec46e`, not a timed usability study or a rendered viewport measurement:

| Surface | Before | After, initially closed | Reduction |
| --- | ---: | ---: | ---: |
| Peer groups in the left rail | 11 sections | 3 sections + Tools & team | 64% |
| Run-setting controls | 17 normally shown controls | 1 summary | 94% |
| Header actions | 6 direct actions | New chat + More | 67% |

The conditional reset-defaults control is excluded from the run-setting baseline. Added location/Back/search controls are deliberately not hidden to chase a percentage. These counts must not be combined into a claim of “70% faster” or “70% less complex overall.” The 70% request is a design target; human task testing is still needed.

## Verification

`npm test` includes `test/focused-workspace.test.js` and `test/secondary-navigation.test.js`. These exercise real inline functions through VM fixtures, including native event phase ordering, stopped events, repeated navigation, Back/Forward races, draft persistence ordering, explicit links, missing destinations, mobile effort synchronization and per-page scroll restoration. Existing rendering, authentication, task, terminal, scheduling and recovery suites remain in the test chain. All inline scripts are syntax-checked separately.

DOM-only checks also inspected the actual HTML for unique IDs, retained feature sections, native disclosure behavior and focus handoff. These do not prove visual layout, real browser history event timing, touch behavior or live Claude streaming.

The first implementation environment could not run a real browser. The review before merging did, in Chromium against a live server (1440×900 and 390×844): a real API-engine chat streamed and finished; Back/Forward across chats and projects; Back across a page boundary and a reload; Kanban following the chat's project and a Kanban history entry keeping its own; Run settings and the Go to… paths; the mobile sheet with no horizontal overflow. That review found and fixed four defects the VM tests could not see: Kanban/Schedule reopening on a project the chat had left, Forward landing on an empty project, a `ReferenceError: hideTerminalView` when a restore ran during boot, and Run settings staying open over the transcript. Visual and touch QA on real phones, Safari and Firefox, and the terminal and Subscription-engine paths were not part of it.

Known cost, not addressed here: on desktop the chat now sits under four horizontal bands (header, run bar, Back/Go to row, tabs), about 44px more than before. The Back/Go to row is deliberately outside the collapsible header zone, so it stays available when the header is collapsed and on phones.

No release, package publication or production deployment is part of this change.
