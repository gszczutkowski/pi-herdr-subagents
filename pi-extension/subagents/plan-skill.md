---
name: plan
description: >
  Planning workflow. Runs a pre-flight scout, then spawns the planner agent
  which clarifies WHAT to build and figures out HOW, with the ability to
  spawn its own scouts/researchers mid-session. Use when asked to "plan",
  "brainstorm", "I want to build X", or "let's design". Requires the
  subagents extension running inside herdr.
---

# Plan

A planning workflow. A scout maps the relevant codebase, then an interactive planner clarifies intent + requirements and designs the technical approach, producing a `plan.md` and todos.

**Preflight before promises:** Verify active `plan_read`, `plan_update`, `subagent`, `read`, `bash`, `write`, and `edit` tools and discover required scout/planner/worker/reviewer roles. Check any additional required skill in the actual loaded skill inventory and read its file; documentation is not proof of installation. The `/plan` command checks its bundled instruction file; direct invocation must perform the same checks. Stop with actionable missing-tool/role/skill details rather than promise a full workflow. Optional researcher, answer, task-writing, or commit helpers may be unavailable: use manual questions/research and project commit conventions (only when authorized), explicitly noting the limitation.

**After successful preflight, announce:** "Let me take a quick look, then I'll send a scout to map the codebase before we start the planning session."

The parent-owned `plan_read`/`plan_update` store is the only execution status source. `plan.md` records design and stable ISC definitions, not a second synchronized execution checklist. Children return proposals/results, never write ancestor plans.

---

## The Flow

```
Phase 1: Quick Assessment (main session — 30s orientation)
    ↓
Phase 2: Scout (autonomous — codebase context)
    ↓
Phase 3: Spawn Planner Agent (interactive — clarifies WHAT, plans HOW, creates todos)
    ↓
    (Planner may spawn its own scouts/researchers mid-session as needed)
    ↓
Phase 4: Review Plan & Todos (main session)
    ↓
Phase 5: Execute Todos (workers — receive plan + scout context)
    ↓
Phase 6: Review
```

---

## Phase 1: Quick Assessment

Quick orientation — just enough to give the scout a focused mission:

```bash
ls -la
find . -type f -name "*.ts" | head -20  # or relevant extension
cat package.json 2>/dev/null | head -30
```

Spend ~30 seconds. Tech stack, project shape, and the area relevant to the user's request. This tells you what to ask the scout to focus on.

---

## Artifact Paths

For a planning run, pick a short `<name>` (e.g. `auth-redesign`) and use a shared directory under `.pi/plans/YYYY-MM-DD-<name>/` for every deliverable. Pass explicit paths in each subagent's task. For read-only scout/reviewer roles, save their final response at the assigned path using the parent's `write` tool, then confirm the file exists with `read`. Roles with `write` may save their own assigned artifacts. Never ask a read-only role to bypass its tool policy through bash.

Handoffs carry artifact paths plus targeted summaries, not repeated full report pastes. Include relevant sections or line ranges, decisions, blockers, and evidence needed for the next task. Recipients read the referenced artifacts on demand. Use absolute paths when working directories differ; verify recipient access and, if unavailable, provide only the necessary excerpt or request access.

Standard filenames:

- `.pi/plans/YYYY-MM-DD-<name>/scout-context.md`
- `.pi/plans/YYYY-MM-DD-<name>/plan.md`
- `.pi/plans/YYYY-MM-DD-<name>/review.md` (optional, for reviewer output)

---

## Phase 2: Scout

**Always spawn a scout before the planner.** The scout's context feeds into the planning session — it lets the planner skip re-asking questions whose answers live in the code, and gives it a solid base to design from.

```typescript
subagent({
  name: "🔍 Scout",
  agent: "scout",
  task: `Analyze the codebase for [user's request area]. Map file structure, key modules, patterns, conventions, and existing code related to [feature area]. Focus on what a planner would need to understand before designing this feature.

Return findings in your final response; I will save them to: .pi/plans/YYYY-MM-DD-<name>/scout-context.md`,
});
```

**Wait for the scout to finish.** Save its final findings to the assigned context path with `write`, then verify the file with `read` before passing it to the planner.

The planner can spawn **additional** scouts or researchers mid-session if it hits a factual gap. That's expected — don't try to pre-scout every possible area.

---

## Phase 3: Spawn Planner Agent

Spawn the interactive planner with the scout's context and the user's request. The planner handles everything from here: clarifying intent, compact requirements engineering, ISC, approach exploration, design validation, premortem, plan artifact, and todos.

```typescript
subagent({
  name: "💬 Planner",
  agent: "planner",
  interactive: true,
  task: `Plan: [what the user wants to build]

Scout context path: [absolute scout-context.md path; read relevant sections]
Targeted summary: [only findings and decisions relevant to this plan]

Save the final plan to: .pi/plans/YYYY-MM-DD-<name>/plan.md
Return proposed tasks with scope, constraints, code examples/references, dependencies, criteria and artifact paths. Do not write the parent's plan store.`,
});
```

**The user works with the planner.** It will clarify requirements lightly (1-2 rounds of questions, not a deep spec session), propose approaches, validate the design, run a premortem, write the plan, and create todos with mandatory code examples.

When done, the user presses Ctrl+D and the plan + todos are returned to the main session.

### The planner may spawn its own specialists

During the session, the planner can spawn:
- **`scout`** — when a design decision depends on existing code it hasn't read
- **`researcher`** — when a decision depends on external facts (library tradeoffs, best practices, API behaviors)

These are internal to the planning session. You'll see them in herdr but don't need to intervene.

### Optional: extra scout after planning

If the planner significantly changed scope (new subsystems, areas the original scout didn't cover), spawn another scout targeting the new areas before workers start:

```typescript
subagent({
  name: "🔍 Scout (updated scope)",
  agent: "scout",
  task: "The plan changed scope. Gather context for [new areas]. Read the plan at [plan path]. Focus on [specific files/modules the planner identified that weren't in the original scout].",
});
```

Pass the updated context path and a targeted summary of new findings to worker tasks.

---

## Phase 4: Review Plan & Todos

Once the planner closes, read the design artifact and validate its proposed tasks with the user. Only the parent imports approved definitions:

```typescript
plan_read({});
plan_update({ expectedRevision: 0, command: { action: "create", title: "Approved design" } });
plan_update({ expectedRevision: 0, command: { action: "add", planId: "<returned planId>", title: "Implement outcome", details: { scope: "Constraints, code references and plan.md path", criteria: [{ criterionId: "<caller-generated UUID>", text: "Verified outcome" }], dependencies: [] } } });
plan_read({ taskId: "<returned taskId>" });
```

Use the latest returned revision for every update (create starts at revision 0). Existing plans are read and extended, not replaced. Foreign/historical copies are read-only until an explicit parent `detach` decision; never silently detach or write an ancestor session.

Review with the user:

> "Here's what the planner produced: [brief summary]. Ready to execute, or anything to adjust?"

---

## Phase 5: Execute Todos

Use coherent, verifiable units of work, not a fixed time limit. Each unit needs one meaningful outcome, explicit scope, dependencies, and acceptance evidence; keep related implementation and tests together. In the default workflow, spawn workers sequentially. Each worker gets the plan path and scout context:

```typescript
// Workers execute todos sequentially — one at a time
subagent({
  name: "🔨 Worker 1/N",
  agent: "worker",
  task: "Implement taskId [taskId] from planId [planId]. Return results and criterion evidence for parent review; do not mutate ancestor state. Task definition: [scope, constraints, criteria, code references]. Plan: [plan path]\n\nScout context path: [absolute scout-context.md path]. Read [relevant sections]. Targeted summary: [relevant findings, including re-scout paths if any]",
});

// Parent verifies/imports the result, then starts the next dependent task
subagent({
  name: "🔨 Worker 2/N",
  agent: "worker",
  task: "Implement taskId [next taskId] from planId [planId]. Return results and criterion evidence for parent review; do not mutate ancestor state. Task definition: [scope, constraints, criteria, code references]. Plan: [plan path]\n\nScout context path: [absolute scout-context.md path]. Read [relevant sections]. Targeted summary: [findings relevant to this task]",
});
```

**Default: run code-modifying workers sequentially in a shared repository**, including when they touch different files; the index, commits, and generated files are still shared.

Parallel code workers are allowed only in separate isolated git worktrees, each with its own branch and explicit working directory, non-overlapping task scope, and a designated integration owner. Pass absolute artifact paths and verify access across worktrees. After workers finish, the integration owner reviews and integrates their changes in dependency order, resolves conflicts, and runs combined tests and review on the integrated tree. Individual worker success is not integrated acceptance. Without isolation and an integration stage, stay sequential.

Commits require both permission under project policy and user authorization. Honor an explicit request for per-point commits when permitted; todo completion alone is not authorization. If instructions conflict, report the conflict before committing. Without authorization, leave changes uncommitted and report paths and verification evidence. Use the `commit` skill when available and authorized, otherwise follow project commit conventions.

---

## Opt-in execution: one coordinator per feature (Pi only)

Use this execution path only if the user explicitly requests one coordinator per feature. It does not change ordinary `/plan` or `/iterate`. In the existing parent-owned plan, record one task per feature with scope, dependencies, criteria and durable references. Execute one feature at a time by default, in dependency order. Check that the active Pi session has `plan_read`, `plan_update`, and `subagent`, and that discovery shows `feature-coordinator` and `worker` before promising this mode.

Start an attempt for the ready feature, then bind a fresh coordinator to that attempt using `planTask` and the latest revision returned after starting the attempt. Give it an explicit working directory and do not set `fork: true`:

```typescript
subagent({
  name: "Feature: CSV export",
  agent: "feature-coordinator",
  cwd: "/absolute/path/to/checkout",
  task: "Coordinate the assigned CSV export feature and return a single verified result.",
  planTask: { planId, taskId, attemptId, expectedRevision: revisionAfterAttempt },
  assignmentContract: {
    objective: feature.title,
    scope: feature.scope,
    criteria: feature.criteria,
    dependencies: feature.dependencies,
    inputs: feature.artifacts.map(({ ref }) => ref),
    decisions: ["Export returns CSV text; it does not write a file."],
    files: ["/absolute/path/to/checkout/src/export.ts"],
    changeConstraints: ["Do not modify the settings UI."],
  },
});
```

Omit `assignmentContract` to derive it from the bound task. If supplementing it as above, copy the five bound fields exactly from the current task (including array order); only decisions, files, and change constraints are caller-supplied. Pass only feature-specific supplemental context; the coordinator starts without copied conversation. It delegates focused work and checks to its own children without the ancestor's `planTask`. Their results wake the coordinator, not the main session. A normal stop while supervised work can wake the coordinator does not publish an intermediate result. Expect one structured feature result from `subagent_done({ result, close: true })`, or a prompt blocker/help/error report. A stop without explicit completion and without such a wake source reports incomplete work.

The main session inspects the bound result and its references, then records `evidence` with the exact `criterionId`, inspected `ref` and canonical `resultEventId`. Only the parent calls `accept`, mapping all criteria to matching evidence IDs and giving a reason. Record durable decisions and references in the plan. Start the next fresh coordinator only after its dependencies are accepted; pass only applicable decisions and accessible references from those dependencies, not whole reports or unrelated feature details. Partial, blocked, unstructured or uncertain results do not unlock dependent work. Choose independent work only as an explicit decision. After restart, read the plan and saved results/recovery records before acting; never start again blindly or replace a run whose fate is uncertain.

## Parent Execution and Acceptance Commands

Before spawn, parent starts an attempt. A `planTask` binding registers the run automatically. For an unbound launch, the manual registration and result commands are:

```typescript
plan_update({ expectedRevision: revision, command: { action: "attempt", planId, taskId, mode: "start" } });
// Spawn via subagent with ordinary supported arguments; take attemptId from update response.
plan_update({ expectedRevision: revision, command: { action: "run", planId, taskId, attemptId, runId: "<returned runID>" } });
plan_update({ expectedRevision: revision, command: { action: "result", planId, taskId, attemptId, origin: { sessionId: "<plan authority sessionId>", branchInstanceId: "<plan authority branchInstanceId>" }, result: { eventId: "<unique event ID>", runId: "<returned runID>", ref: "<result artifact path>", kind: "result" } } });
plan_update({ expectedRevision: revision, command: { action: "evidence", planId, taskId, evidence: { criterionId, ref: "<verified command/result or artifact>" } } });
plan_update({ expectedRevision: revision, command: { action: "accept", planId, taskId, criteria: { [criterionId]: ["<returned evidenceId>"] }, reason: "Parent verified each criterion" } });
```

Read latest revision before each command; never reuse the sample variable without updating it. Results enter review, not acceptance. Map every criterion to verified evidence IDs. For blockers use parent `status` with `transition: "block"` and a specific `reason` (or import a run-bound `ping` result). Retry uses `attempt` with `mode: "retry"`, retaining taskId. A process exit cannot prove acceptance.

## Phase 6: Review

In the default workflow, after all todos are complete:

```typescript
subagent({
  name: "Reviewer",
  agent: "reviewer",
  interactive: false,
  task: "Review the recent changes. Plan: [plan path]. Return the review in your final response; I will save it to [review path]. Do not modify code or write files.",
});
```

Save the review response to the assigned review path with `write` and verify it with `read`. Triage findings:

- **P0** — Real bugs, security issues → fix now
- **P1** — Genuine traps, maintenance dangers → fix before merging
- **P2** — Minor issues → fix if quick, note otherwise
- **P3** — Nits → skip

Parent adds tasks for P0/P1 via `plan_update` with criteria and references, runs workers to fix, and re-reviews substantial fixes.

---

## Parent-owned subagent cleanup

After receiving a subagent result and before reporting done, review the current plan and concrete remaining actions for each owned idle child. Preserve its result first. If no pending review, fixes, retry or other follow-up needs that child, use `subagent_close` with its owned id; do not leave it open for hypothetical future questions or an unrelated unfinished task.

- Retain a child only for a concrete pending action or an explicit user request, and record that reason in the plan or final handoff. A missing plan or task binding alone does not authorize closure. Explicitly user-managed interactive sessions require user authorization to close.
- Respect the existing busy-state, unsent-draft, pending-input, ownership and branch/custody guards. Never bypass them with force-kill, terminal typing or interruption of active work for cleanup.
- If `subagent_close` is unavailable or returns rejected, pending or uncertain, report the unresolved status rather than claiming closure. Any explicit recheck must use the same id, not a polling loop.
- This is a parent decision followed by an explicit tool call, not background automatic cleanup triggered by idle state or plan acceptance. It applies to workers, scouts and reviewers alike, including after the final review has been triaged.

## ⚠️ Completion Checklist

Before reporting done:

1. ✅ Scout ran before the planner?
2. ✅ Scout context was passed to the planner?
3. ✅ All required tasks accepted by the parent after criterion evidence verification (not merely child/process completion)?
4. ✅ Commit handling matches project policy and user authorization (including requested per-point commits), or uncommitted paths and verification evidence are reported?
5. ✅ Reviewer has run (always in the default workflow; as required by risk or criteria in opt-in execution)?
6. ✅ Any reviewer findings triaged and addressed?
7. ✅ Every owned idle subagent closed via `subagent_close`, retained with a concrete reason, or reported with unresolved close status?
