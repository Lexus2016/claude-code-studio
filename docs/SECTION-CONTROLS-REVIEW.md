# Section-by-section control and form review

Follow-up to the focused workspace change (`561302d`). The goal is clearer, more comfortable controls and forms across the application, while preserving existing capabilities, execution settings and security warnings. This is a code and interaction-logic review; no rendered visual acceptance is claimed.

## Common form language

Dialogs now share readable headings and field text, consistent input/button geometry, stronger keyboard focus, identifiable primary actions, inline invalid/error feedback and mobile-friendly text sizing. These shared styles are supporting work, not the sole basis for calling a section improved below.

## Coverage

| Section / flow | Result | Concrete change or reason to retain |
| --- | --- | --- |
| Login and first setup | Improved | Connected field labels and password-manager hints, accessible errors/focus, recoverable status loading with timeout and Retry, guarded submit/busy controls. Authentication policy is unchanged. |
| Global workspace and cross-project search | Reviewed, retained | Existing search, current activity, project grouping and explicit all-project links remain; main navigation and Go to already provide direct access. No extra wizard or nested navigation added. |
| Configuration form | Improved | Opens immediately with loading/retry; native tabs/section controls; clear automatic-save versus manual-file-save guidance. Existing search, source precedence, restart/read-only/security warnings remain visible. |
| Raw configuration and CLAUDE.md files | Improved | Unsaved-change handling across tabs/Close/browser departure, opening-project-bound writes and request identity guards. Raw editing remains available. |
| MCP add/edit, Form/JSON | Improved | Associated labels, keyboard controls, duplicate-submit/error handling, dirty dismissal protection and mobile grouping. Both editing modes and all transport fields remain. |
| MCP server settings | Improved | Accessible credential/environment fields, save feedback and draft safety. Credential data is not added to browser storage. |
| MCP import/export/delete | Improved / retained | Native accessible import picker, file-read/import errors and pending handling. Failed deletion retains the server and active selection. Existing export format and warnings remain. |
| Skills | Improved | Useful empty state; failed delete/upload retains controls/items and reports errors; upload guards repeated submission. Auto/manual selection, categories and terminal paste remain. |
| Commands | Improved | Explanation, empty state, native keyboard insertion, inline save errors and duplicate guard; failed delete preserves the command. Prompt content and terminal paste remain. |
| Bots form and library | Improved | Name, purpose and prompt first; optional model/appearance disclosure; visible project/global sharing; library loading/error/retry. Identity-aware saves cannot insert a mention into another chat after delayed completion. |
| Bot templates, emoji and import/export | Reviewed, retained | Existing template/emoji choice, import conflict checks, reserved handles, export and destructive warnings remain. No new steps added to these established flows. |
| External Agents | Improved | Both terminal-only and delegation-only capabilities stay clear; optional model/effort catalogs and restore/resume fields grouped; configured groups open automatically. Save errors and busy states are explicit. |
| Delegation setup | Improved | Native agent selectors, keyboard-operable Handoff/Sync radios, immediate loading/retry, mobile arrangement, bounded pending operations. Model/effort and both delegation modes remain. |
| Delegation status/dialog/stop | Reviewed, retained | Existing active-run controls, messages, history, check/stop and handoff semantics remain. Late setup completion is scoped to its originating project/session/tab. |
| Local/remote project creation and clone | Improved | Clear field associations and selection guidance, repeated-submit guard, retained in-page draft, error/uncertain-result feedback. Late creation cannot pull the user away from a newer workspace. Existing git-init, branch and SSH choices remain. |
| Project rename/delete and editor links | Reviewed, retained | Existing confirmations, worktree/session protection and local/remote editor links remain. These are not replaced with a new flow. |
| Folder picker | Improved | Separate native Select and Open-folder actions replace timed single/double-click guessing; latest-request protection and in-context Retry; custom names are preserved while auto-generated names follow selection. |
| File browser | Improved | Loading/error/retry, latest-project/path protection, keyboard-operable rows, visible keyboard action affordances. Remote read-only restrictions remain. |
| File preview, download/copy/share | Improved / retained | Preview ignores stale file/project responses and Close; existing rendered Markdown, image/PDF/text handling, download/copy/share/editor behavior and remote restrictions remain. |
| SSH add/edit/test | Improved | Connected labels, clear auth choice state, port validation, pending/inline errors and stale test-result protection. Password masking, blank-on-edit preservation and the existing security warning remain. |
| SSH list/delete and nested add-host | Improved / retained | Loading failures expose Retry; failed deletion cannot claim success. Existing add-host → project/import flow and saved host source remain. |
| CLI session import | Improved | Proper modal focus/Escape, latest source/path listing guard, cleared stale selections, bounded repeated-submit protection and uncertain-result feedback. Local/remote listing and per-project mapping remain. |
| JSON session import/export | Reviewed, retained | Existing file format, import validation and export actions remain available. No duplicate alternate import surface added. |
| Terminal picker, live pane, reconnect, key row | Reviewed, retained | Existing capabilities and recovery controls remain reachable. Their transport, reconnect, shortcut-byte and permission behavior are deliberately unchanged. |
| Telegram setup/pairing/devices | Improved / retained | Associated token label and comfortable controls; failed stop/connection-setting writes report errors rather than claiming success. Existing pairing expiry, lock, revoke confirmation and device information remain. |
| Remote access / tunnel | Improved / retained | Visible keyboard focus on provider cards, connected token/URL labels, accessible errors, accurate stop-failure state. Internet-exposure confirmation, token handling and start guard remain unchanged. |
| Board task/edit/group forms | Improved | Clear field spacing/grouping, accessible labels/selected controls/help, mobile sizes and guarded saves. Execution, worktree, scheduling and task/group fields remain. |
| Schedule and recurrence forms | Improved | Matching form controls, connected date/session/recurrence guidance, accessible execution selection and guarded save. Recurrence semantics and timestamps remain unchanged. |
| Dashboard | Improved | Accessible loading status and in-context retry. Existing metrics and empty-state meanings remain. |
| Shared modal/mobile/Back behavior | Improved | Descriptive close controls, Escape fallback, consistent focus/field styling and refusal-aware same-document Back. Existing chat draft persistence and mobile settings changes remain. |

## Drafts, requests and Back

- Secrets are not saved as navigation or form drafts in local/session storage by this change.
- A failed write retains entered fields where the existing form supports them. There is no automatic retry of a possibly completed write.
- Timed-out writes have an unknown server outcome; the interface tells the user to refresh before retrying. Closing a pending form does not claim to cancel server work.
- Dirty raw settings and MCP forms request the browser’s native leave confirmation; canceled departure leaves reconnection active. This does not persist secret-bearing drafts, and browsers may suppress native prompts without prior interaction.
- Draft protection is specific to the implemented flows. Project inputs remain in their existing DOM while the page stays open; this is not persistence across reloads.
- If a dirty-modal discard prompt is declined during same-document Back, the current workspace remains coherent with the still-open form. The consumed history entry is replaced with that workspace snapshot. There is no recursive Back/Forward operation; this can consume an older visit rather than preserving every history entry.
- All behavior involving real rendered Back/Forward, touch, focus order, long-running streams and server failures still requires browser acceptance testing.

## Verification and limits

The aggregate test command includes focused workspace, secondary navigation, section controls, settings/MCP, team forms and remaining-page forms regressions, alongside the original rendering/backend/security/task/terminal suites. Tests execute source functions in VM fixtures and validate markup/payload preservation; they do not substitute for a real browser.

The implementation environment could not run a browser. The review before merging did, in Chromium against live servers (1366x768, 1440x900, 1920x1080, 390x844, 390x667): configuration open/close/save, bot, MCP, SSH, external-agent, CLI-import and New project dialogs, the folder picker, Kanban backlog saves, the Schedule form, Dashboard, and the login and first-run setup pages. It found and fixed:

- **New project — the Add button was off screen and unreachable** at 1366x768 and 1440x900 (only the folder list scrolls). The list now gives way.
- **Kanban/Schedule — a Save made while the previous save's board refresh ran was silently ignored.**
- **Configuration — a CRLF file counted as edited** once its tab was shown (false "Discard unsaved changes?" and browser leave prompt).
- **New project — closing during the first folder listing left "Loading…" for good** on reopen.
- **A config.json the server refused ("Invalid JSON") was reported as "may have been saved"**; the reason is shown again.
- Reopening a dialog whose cancelled action still ran did nothing; it now says "Saving…". A stale SSH test result no longer leaves "Connecting…".

Confirmed separately: the parent version could fail to open Configuration at all — it awaited three requests without a catch before showing the dialog, so one hung or non-JSON reply meant no dialog and no message (reproduced by holding `/api/config/resolved`). This version opens the dialog first and reports a failed load inside it.

Known and not changed: declining the discard prompt during Back rewrites the entry the browser landed on (described above), so that entry's earlier visit is lost. Not tested: Safari/WebKit and Firefox, real touch devices, the Subscription engine. No whole-product 70% speed or complexity claim is made.

No backend API contract, production deployment, release, merge or package publication is part of this follow-up.
