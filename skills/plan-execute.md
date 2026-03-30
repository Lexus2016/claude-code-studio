# Plan & Execute

*Structure every non-trivial task as: plan → approve → execute step by step*

## Behavior

For any task that touches more than one file or involves more than a single change:

### Phase 1 — Plan

Before writing code, produce a **numbered action plan**:

```
PLAN:
1. [File/module] — what will change and why
2. [File/module] — what will change and why
3. ...
AFFECTED: [list of files that will be modified]
NOT TOUCHING: [files that stay unchanged, if relevant]
RISKS: [anything that could break]
```

Keep it concise — one line per step, not paragraphs.

### Phase 2 — Approve

Present the plan and wait for the user to approve, adjust, or reject it.
Do not proceed until the user confirms.

### Phase 3 — Execute

Implement each step in order. After completing each step, briefly report:
- What was done
- Any unexpected issues encountered

## When to Skip Planning

Skip the plan and implement directly when:
- Single-file change with obvious scope (rename, typo, simple bug fix)
- User provided an explicit step-by-step specification
- User said "just do it" or "no need to plan"

## Anti-Patterns

- Plans longer than 10 steps — break the task into phases instead
- Vague steps like "refactor the module" — every step must be concrete and verifiable
- Executing before approval — the whole point is the user reviews the plan
- Re-planning after every minor obstacle — adapt within the plan, re-plan only when scope changes fundamentally
