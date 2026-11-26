# Project Instructions

## Subagent Management

- The main agent coordinates work and is responsible for reviewing and accepting results.
- Delegate when beneficial; handle simple changes without subagents.
- Match roles to tasks: scout for exploration, worker for implementation,
  reviewer for independent review.
- Every assignment must specify the goal, file scope, constraints, and completion
  criteria. Provide relevant context, not the entire conversation.
- For multi-step work, record tasks and dependencies using plan_read /
  plan_update. Bind subagent runs to the corresponding tasks.
- Run only independent tasks in parallel. Do not assign concurrent edits
  to the same files.
- Results arrive automatically; do not poll for completion.
- Subagent completion does not mean task acceptance. Inspect changes,
  acceptance criteria, and test results. Review and tests must cover
  the same version of the code.
- If review finds defects, allow up to six repair rounds. After each round,
  rerun review and relevant tests against the updated code. If defects remain
  after the third round, stop and report unresolved issues to the user.
  Report blockers or scope changes immediately.
- After preserving the result, close unneeded sessions with subagent_close.
  Keep a session open only for a concrete follow-up.
- After a restart, read the plan and recovery records. Saved state is not
  proof of process liveness; do not automatically rerun uncertain tasks.
- Subagents must not commit or push without explicit user authorization.
