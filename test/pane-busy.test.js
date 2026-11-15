// GitHub #130 — "Live pane and web UI out of sync: task shown finished in live pane,
// web UI stays waiting".
//
// paneBusy() gates EVERY exit of the subscription engine's poll loop except the idle
// watchdog: the turn-end break needs !busy, and so does the quiet safety net. A pane
// that reads busy forever therefore holds a finished turn open for
// CLAUDE_IDLE_TIMEOUT_MS (10 min) and ends it as a timeout. Two ways it did:
//
//   1. The elapsed-timer pattern was matched against the WHOLE pane. CLI 2.1.311
//      renders a finished subagent as `Done (${uses} · ${tokens} · ${duration})` (the
//      template string is in the shipped bundle), so "⎿  Done (3 tool uses · 12.4k
//      tokens · 8s)" left anywhere on screen matched `8s)` for as long as it stayed
//      visible.
//   2. Animation was detected by comparing the WHOLE pane, so a statusline clock
//      below the input box, or a draft typed into the live pane, read as a spinner.
//
// The panes below are built here rather than captured, because no idle capture
// exists in the repo; the busy one copies the bottom rows of a live studio pane on
// CLI 2.1.311 (spinner line, labeled input box, footer) with the statusline's
// personal values replaced. Pure functions only: no tmux, no server.
//
// Run: node test/pane-busy.test.js
const assert = require('assert');
const { paneBusy, paneBusyReason, paneAwaitingInput } = require('../claude-interactive');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const RULE = '─'.repeat(72);
// A chat opened with --name draws its title INTO the top rule (captured live).
const TOP = '─'.repeat(58) + ' Коля-Програміст ─';
const footer = (clock) => [
  `  🤖 Opus 5.5 │ 📁 project │ ⏱ ${clock} │ 💰 $1.00`,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
];
const pane = (body, { top = TOP, draft = '', clock = '12h06m' } = {}) =>
  [...body, '', top, `❯ ${draft}`, RULE, ...footer(clock)].join('\n');

const FINISHED = [
  '⏺ Agent(Survey the test suites)',
  '  ⎿  Done (3 tool uses · 12.4k tokens · 8s)',
  '',
  '⏺ All three suites pass.',
];
const WORKING = (secs) => [
  '⏺ Reading the files.',
  '',
  `✶ Grooving… (2m ${secs}s · ↓ 8.0k tokens)`,
];

console.log('\n── #130: a finished turn reads idle');
check('a finished subagent line on screen is not a running spinner',
  paneBusy(pane(FINISHED), null), false);
check('same, against an identical previous capture (the poll-loop shape)',
  paneBusy(pane(FINISHED), pane(FINISHED)), false);
check('a statusline clock ticking below the input box is not animation',
  paneBusy(pane(FINISHED, { clock: '12h07m' }), pane(FINISHED, { clock: '12h06m' })), false);
check('a person typing a draft in the live pane is not animation',
  paneBusy(pane(FINISHED, { draft: 'fix the' }), pane(FINISHED, { draft: 'fix' })), false);
check('an unlabeled input box is recognised the same way',
  paneBusy(pane(FINISHED, { top: RULE, clock: '1m' }), pane(FINISHED, { top: RULE, clock: '2m' })), false);
check('an empty capture is idle', paneBusy('', null), false);
check('no capture at all is idle (never confirms work)', paneBusy(null, null), false);

console.log('\n── a working turn still reads busy');
check('the spinner line on screen is busy, even with no previous capture',
  paneBusyReason(pane(WORKING(25)), null), 'spinner');
check('the spinner ticking between two polls is busy',
  paneBusy(pane(WORKING(26)), pane(WORKING(25))), true);
check('new conversation text above the box is animation',
  paneBusyReason(pane([...FINISHED, '⏺ One more line.']), pane(FINISHED)), 'animation');
check('the older spinner shape "Cogitating… (8s · esc to interrupt)" is busy',
  paneBusy(pane(['✻ Cogitating… (8s · esc to interrupt)']), null), true);
check('a three-dot spinner verb is busy',
  paneBusy(pane(['* Thinking... (12s)']), null), true);
check('the bare "(8s · esc to interrupt)" engine-idle-reaper uses is still busy, via the marker',
  paneBusyReason('(8s · esc to interrupt)', null), 'legacy-marker');
check('legacy marker outside a spinner line', paneBusyReason('working — esc to interrupt', null), 'legacy-marker');
check('no input box on screen (a dialog replaced it) falls back to the whole pane',
  paneBusy('Pick one\n❯ Yes\n  No\nclock 1', 'Pick one\n❯ Yes\n  No\nclock 2'), true);

console.log('\n── review findings on PR #143: the box must be THE input box');
// A rule/caret/rule block quoted in the history is not the input box. With no real box
// at the bottom the detector falls back to the whole pane; otherwise that block would
// cut the live spinner off and a working turn would read idle.
check('a framed quote in the history does not hide a live spinner',
  paneBusy(['----------------------------------------', '> Compiling modules', '----------------------------------------',
    '', '✶ Thinking… (15s · ↓ 4.2k tokens)', 'more output', 'and more', 'and more', 'and more', 'and more', 'and more', 'last'].join('\n'), null), true);
// The spinner is the line right above the box; an ellipsis-and-seconds phrase higher
// up in a finished answer is history, not work.
check('ellipsis + seconds higher up in a finished answer is not the spinner',
  paneBusy(pane(['⏺ Building bundle… (finished in 12s)', '⏺ Step two', '⏺ Step three', '⏺ Step four', '⏺ Done.']), null), false);
// RULE_RE (the widget detectors' box) is untouched: a dialog whose LABELED header rule
// sits right above its caret must stay a widget, never be taken for the input box.
check('a dialog under a labeled header rule is still a widget',
  paneAwaitingInput([TOP, '❯ 1. Yes', '  2. No', RULE].join('\n')), true);
// Round 2. A dialog replaces the input box, so the no-box branch runs — and a finished
// subagent line above the dialog must not read as a spinner there either: `busy` forces
// `awaiting` false, so the prompt would never be announced and the turn would hang on
// the very question the user is meant to answer.
const DIALOG = [...FINISHED, '', 'Do you want to proceed?', '❯ 1. Yes', '  2. No, and tell Claude what to do differently'].join('\n');
check('a dialog under a finished subagent line is not busy', paneBusy(DIALOG, DIALOG), false);
check('...so it is announced as a prompt', paneAwaitingInput(DIALOG), true);
// A narrow pane leaves only a few dashes before a long label. The real top rule must
// still be the one found; a rule-plus-"❯ old prompt" in the history must never be taken
// for the box, which would cut the live spinner off the conversation.
const NARROW_TOP = '──── Коля-Програміст-з-дуже-довгою-назвою ─';
const HISTORY = ['──────────────────────', '❯ the previous prompt', '⏺ The previous answer.', '', '✶ Grooving… (12s · ↓ 1.0k tokens)'];
check('a narrow labeled top rule is the box, not a rule in the history',
  paneBusyReason(pane(HISTORY, { top: NARROW_TOP }), pane(HISTORY, { top: NARROW_TOP })), 'spinner');
check('a real numbered widget above a labeled input box is still a widget',
  paneAwaitingInput(['Allow this command?', '❯ 1. Yes', '  2. No', '', TOP, '❯ ', RULE].join('\n')), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
