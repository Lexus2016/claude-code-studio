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

Kanban, Schedule and Dashboard preserve per-tab, per-history-entry project/search and scroll state. Kanban also preserves board and column scroll positions during refresh. Explicit URL filters and session deep links take precedence over remembered state. Page departure saves the chat draft, attachments and reply selection through the existing persistence path.

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

In the implementation environment, real Chromium preview was blocked by socket creation restrictions; the supported cloud browser could not reach the local preview. No screenshots or visual acceptance are claimed. Live tmux/SSH checks self-skip when those capabilities are unavailable. Before merging, perform desktop/mobile visual QA and live chat/terminal smoke tests on a normal supported environment.

No release, package publication or production deployment is part of this change.
