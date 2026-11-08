'use strict';
// One number for how much text a task may carry, shared by every place that writes
// or renders it: the task INSERT/UPDATE statements in server.js, the MCP tool schema
// in mcp-task-manager.js, and the description/notes fields in public/schedule.html and
// public/kanban.html. Each page keeps its own copy of the literal because the two
// pages are single static files with no build step; test/task-text-limit.test.js fails
// if any copy drifts from this one.
//
// 2000 was the old cap, and it is smaller than a useful prompt handed to Claude: a task
// that names the files, the expected behaviour and the acceptance checks runs past it,
// and both the server and the textarea cut the end off with no message. 20000 leaves
// room for a long prompt while keeping a single task row small enough to list with the
// board (express.json and the SQLite column are far above it, so neither is the binding
// limit).
const MAX_TASK_TEXT = 20000;

module.exports = { MAX_TASK_TEXT };
