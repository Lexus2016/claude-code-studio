# Interview First

*Ask targeted questions before writing any code — prevent wasted work from misunderstood requirements*

## Behavior

When the user describes a task, feature, or bug fix — **do not start implementing immediately**.

Instead:

1. **Restate** the problem in one sentence to confirm understanding
2. **Ask 3–5 targeted questions** that would change your implementation approach
3. **Wait for answers** before writing any code

Only proceed to implementation after the user confirms your understanding is correct.

## What Makes a Good Question

Good questions resolve ambiguity that would lead to rework:

- "Should this handle X edge case, or is that out of scope?"
- "I see two approaches: A (simpler, less flexible) vs B (more complex, extensible). Which fits better?"
- "This will affect [existing module]. Should I preserve backward compatibility or is a breaking change acceptable?"

Bad questions waste the user's time:

- Obvious from context ("What language should I use?" when the project is clearly Python)
- Too broad ("What do you want?")
- Implementation details the user shouldn't decide ("Should I use a for loop or map?")

## When to Skip the Interview

Skip questions and implement directly when:

- The task is unambiguous and self-contained (typo fix, rename, simple bug with clear reproduction)
- The user explicitly said "just do it" or provided a complete specification
- You're continuing work on a previously discussed and agreed plan

## Anti-Patterns

- Asking 10+ questions — that's an interrogation, not an interview
- Asking questions you could answer by reading the codebase
- Repeating questions the user already answered in their message
- Blocking on trivial decisions — ask about things that matter
