# pi-herdr-subagents

Async subagents for [pi](https://github.com/earendil-works/pi) running exclusively in [herdr](https://herdr.dev). Spawn, orchestrate, and manage sub-agent sessions in dedicated herdr tabs or panes. **Fully non-blocking** — the main agent keeps working while subagents run in the background.

## How It Works

Call `subagent()` and it **returns immediately**. The sub-agent runs in its own terminal pane. A live widget above the input shows all tracked agents with their projected state — for example `starting`, `active`, `waiting`, `interrupted`, `stalled`, `running`, or `finalizing`. The header summarizes **active** (processing) vs **open** (not processing). When every tracked subagent is open, the border switches to amber. When a sub-agent finishes, its result is **steered back** into the main session as an async notification — triggering a new turn so the agent can process it.

```
╭─ Subagents ──────────────────── 1 active · 1 open ─╮
│ 00:23  Scout: Auth (scout)        active · bash 7m │
│ 00:45  Scout: DB (scout)                waiting 2m │
╰────────────────────────────────────────────────────╯
```

For parallel execution, just call `subagent` multiple times — they all run concurrently:

```typescript
subagent({ name: "Scout: Auth", agent: "scout", task: "Analyze auth module" });
subagent({ name: "Scout: DB", agent: "scout", task: "Map database schema" });
// Both return immediately, results steer back independently
```

### Session provenance

Pi-backed launches carry optional versioned lineage: canonical session paths and
header IDs for the immediate parent, root and child, plus root branch assignment
references. Standalone still starts with no conversation; fork alone copies Pi
history. The display name is never identity. Saved profiles, assignment cards,
durable runs and result details retain original lineage across resume and live
follow-up. Legacy launches may have no lineage. Foreign harnesses do not promise
Pi context inheritance or verified native session identity. This metadata grants
no terminal custody or child authentication.

Explicit handoff history is stored in a root-owned `subagent-history` artifact
directory, carried to descendants through assignment metadata. Immutable atomic
records keep at most 320 UTF-8 bytes of explicit summary and four artifact/session
references: assignments, pings, results, continuation decisions and authoritative
plan status/acceptance changes. No hidden reasoning, full reports, conversations
or general tool chatter are copied. Nested results still report to the immediate
parent; descendant history never calls a model-facing send/wake API.

Root reads require a matching native active-branch assignment and custody
checkpoint/token plus root header ID and canonical file. A copied/forked root
cannot ingest history merely by pointing at the same directory. This is bounded,
best-effort history under same-user filesystem trust, not authenticated messaging,
a security sandbox, a second task store or proof of process liveness. Unknown or
partial records are ignored. Hard-link publication must be supported by the local
filesystem; publication failures omit history without changing task execution.
Reads cap directory enumeration at 10,000 records and retain at most 2,000 events;
older omitted records remain on disk. File fsync does not promise directory fsync
or survival of every event after power loss.

`/subagents-tree` toggles a separate native provenance widget, even with no active
processes. Use `expand`, `compact`, `toggle <sessionId>` or `refresh`. Expanded
nodes show the last three bounded explicit events. The tree caps sessions at 200,
depth at 16 and output at 120 width-aware lines; malformed cycles/disconnected
components cannot recurse indefinitely. It is a history view, not liveness or
terminal controls. Root file observation starts only after `session_start`, is
cleaned up on shutdown, and updates UI without a model turn. Unsupported/missing
filesystem watch support falls back to command/tool refresh. The interactive TUI
renders the widget; other UI modes receive command summaries, while print mode
has no visible widget. No live herdr/provider E2E is claimed by the unit/native
session tests.

### Result delivery boundary

Pi's extension `sendMessage` returns `void`. A normal return acknowledges only
synchronous handoff to Pi, not persistence, model consumption, or successful
asynchronous dispatch. Asynchronous dispatch failures are not visible to this
extension. The lifecycle's `delivered` label means this handoff only.

Spawn and resume persist a versioned manifest and immutable serialized outbox in
`artifacts/<parent-id>/subagent-runtime/manifest.json`. Run preparation precedes
terminal dispatch; dispatch intent precedes the uncertain transport call. Results
and event cursors are committed together before handoff; child event files remain
intact. Atomic same-directory replacements use restrictive permissions where the
OS supports them. A writer lease excludes simultaneous parents; corrupt or future
schemas fail closed rather than resetting state.

Synchronous throws retain the original envelope for bounded-backoff retries.
Outbox `dispatching` is persisted before `sendMessage`, and `handedOff` afterward.
A crash between them is UNKNOWN, not permission to resend. Tombstones are retained.
These records do not promise exactly-once processing or Pi persistence. In-process
reload retains watchers; session replacement suppresses their late callbacks.
Restart policy B: **never automatically relaunch a task from a manifest**.
Startup validates the canonical parent session, header ID and custody checkpoint
on `getBranch()` (not all session entries), acquires a fenced writer generation,
and reserves child sessions before asynchronous probes. A live writer cannot be
replaced. A dead writer may be replaced only with OS PID + birth-identity evidence;
legacy/unsupported/unreadable leases require an explicit decision, never an
age-based steal. Corrupt manifests and stale revisions/cursors fail closed.

New Pi children answer fresh generation-bound challenges from a non-model timer.
The responder binds its per-process random nonce, PID, OS creation identity, run,
canonical child session and header ID. Linux `/proc` and Windows process creation
time are supported; unavailable platform probes and legacy/foreign children stay
`unverified`. This assumes same-user filesystem trust, not a security sandbox.
Authenticated live children regain **artifact-only** supervision, including later
keep-open results. Immutable completion artifacts and pending outbox entries can
be reconciled independently of whether a child is alive. Matching active-branch
message IDs suppress replay; their absence is not proof of non-delivery.

Recovered terminal controls, continuation and pane closing are **disabled**: pane
presence does not prove pane-to-process binding. Recovered/uncertain session
reservations (including continuation request IDs) are retained, not replayed.
`/tree` detaches controls and durably pauses custody for an explicit branch decision;
fork/new/copied sessions never inherit the old runs. Teardown after custody loss
must not close a potentially reused pane. `/subagents-recovery` reports decisions
and UNKNOWN handoffs; it is not a force-resend, lease-break or relaunch command.
There is currently no automatic or built-in force-resolution of those decisions.
No live terminal-recovery E2E guarantee is made.

**Upgrade boundary:** these guarantees apply only to watchers started with the
outbox implementation. Before upgrading from a pre-outbox release, let all
existing subagents finish and their results return, then reload or restart the
parent. Reloading new code cannot replace completion callbacks already captured
by an older watcher; those callbacks can still call a stale API and lose a result.
An empty legacy runtime can be initialized, but active legacy supervision is not
migrated. Restarting the parent while a child is active does not restore its
supervision; keep its session for manual recovery instead.

## Durable task plans (Pi)

`plan_read` reads the active branch's plan/revision; pass `taskId` for full
criteria, attempts, results, evidence and decision history. `plan_update` takes
`expectedRevision` and a discriminated `command`: `create`, `add`, `edit`,
`attempt` (start/retry), `run`, `result`, `evidence`, `status`, `accept`, or `detach`.
Existing-plan commands also require `planId`. Criteria/artifact IDs are UUIDs.
Results require their original `{ sessionId, branchInstanceId }` authority.
Definition edits invalidate acceptance; acceptance requires evidence for every
criterion. These are parent commands, not worker-controlled snapshot replacement.

Full validated immutable snapshots use native `pi-subagents-plan/v1` entries.
They survive terminal closure, reload, resume and native compaction. Only the
latest entry on `getBranch()` is authoritative, never the last physical JSONL
line. An actual persisted session with a user/assistant message is required:
`--no-session` and setup-only sessions cannot promise durability. Failed appends
disable writes across reload. Reopen the durable session, then call
`plan_read({ reconcile: true })`; an in-memory leaf ahead of disk is not trusted.
Unknown future plan schemas fail closed, never silently create an empty plan.

Restored `in_progress` tasks stay unchanged and are reported as
`recoveryUncertain`: persistence is not process-liveness or completion proof.
Read/update commands never launch work, accept it automatically or restore
runtime supervision. A request-time context projection reads this same store.
This is single-parent serialization, not multi-process CAS or an OS sandbox.

### Optional runtime provenance

To bind `subagent` or `subagent_resume`, first create/start the task attempt with
`plan_update`, then pass `planTask: { planId, taskId, attemptId, expectedRevision }`.
The parent derives authority from its active plan, validates the current attempt
and appends the existing runtime run ID **before terminal dispatch**. An append
or validation failure prevents dispatch. A subsequent launch/transport failure is
recorded as failed/uncertain, not successful work. Native append and terminal send
are not a transaction.

Ordinary unbound subagents are unchanged. Bound live continuation retains its
run/attempt; closed resume adds a run to the same attempt and preserves original
parent authority. Retry is an explicit parent-created attempt on the existing
task, not an implicit new task. Saved launch profiles, assignments and runtime
manifests retain correlation IDs. Assignment cards remain display-only.

Bound launches also derive a bounded assignment contract from the task and deliver
its criteria and constraints to the model, not only the card. Optional
`assignmentContract` supplies explicit supplemental files, decisions and change
constraints; caller-supplied bound fields must agree. `subagent_done({ result,
close: false })` can publish a structured complete/partial/blocked proposal with
artifact/check refs, unmet criterion IDs and risks. These are review proposals,
not accepted evidence. Plain-text and legacy results remain supported. See
[assignment/result contracts](CONTRACTS.md) for fields, bounds and the explicit
parent evidence/acceptance workflow.

The shared completion adapter imports the exact canonical delivery event ID.
Successful completion enters review, never acceptance; parent evidence can cite
that result ID and acceptance still requires criterion evidence and a parent
decision. Duplicate imports are idempotent; late events cannot reopen terminal
tasks. Import failure never suppresses the original result handoff: immutable
outbox envelopes (including handed-off ones) remain retry sources after reload
or recovery. Wrong-branch/origin imports are deferred, not redirected; select the
original branch and reconcile any plan storage fault. `/subagents-recovery`
reports pending import errors and retries them; context requests also retry.
Existing runtime writer leases, branch custody and recovery identity gates still
apply. Recovery never relaunches work.

### Task panel

A separate native widget displays persisted tasks even after the process widget
removes its agents. Only `accepted` tasks count as checked; result submission,
process exit, skipped and cancelled tasks do not. Role/owner is the explicit
stored `owner` value, not an inferred runtime role. Block reasons, unmet task
dependencies, read-only errors and recovery uncertainty remain visible. For a
bound child, `caller_ping` persists `blocked` and its actual help-request reason
before result handoff. Closing/removing the child does not clear that blocker;
reload/reopen restores it. Resolving it is an explicit parent decision, and late
or duplicate pings cannot reopen accepted/cancelled tasks. If task import is
pending, the original ping is still delivered and its outbox envelope is retained
for import retry; no blocker is fabricated on another plan branch.

- `/plan-view` toggles the compact/full list; compact shows six tasks.
- `/plan-view expand` or `/plan-view full` shows all tasks.
- `/plan-view compact` collapses the list.
- `/plan-view details T1` (or a stable task UUID) shows scope, criteria, attempts,
  run/result references, checks/evidence, acceptance/invalidation decisions,
  status history, artifact and child-session references. These are recorded
  references, not independently verified tests or proof that a process is live.
  Details wrap to terminal width; previews over 120 lines are explicitly clipped.
- `plan_read({ taskId: "..." })` provides full structured task data in non-TUI
  modes too (existing 40KB text limit; no new mutation tool).

Commands change presentation only and do not start model turns or create another
checklist. Store changes and session restore/navigation refresh the widget without
model polling. `/plan` still starts the existing planner workflow. The panel
reads only persisted task state, independently of the runtime process registry.

### Branch and plan-change semantics

- `/new` starts with no plan, even when the session header names a parent.
- Reload/resume restores only the active branch snapshot. `/tree` reads its
  selected point, not a later snapshot elsewhere in the physical session file.
- Fork/clone copies the plan at the actual selected point. Its old authority
  makes it foreign/read-only until `plan_update` with
  `{ expectedRevision, command: { action: "detach", planId, reason } }`.
- Historical `/tree` rollback is also read-only before a write: explicitly
  detach first. This creates a new `planId` and `branchInstanceId`, preserves
  chronological history, and records source plan/authority/revision/entry and
  the reason. The source is never rewritten. Returning to an existing branch
  restores its existing identity, not another automatic clone. Tree topology
  detects abandoned futures; snapshot contents still come only from the active
  `getBranch()` path. Detached alternatives do not take ownership of the source.
- Inherited active attempts become blocked with an explanation. Their original
  attempts/runs/results remain read-only; explicit retry creates a new attempt.
  Result commands carry origin authority and cannot apply to the wrong branch.
- Definition edits on an accepted task move it back to review and retain the
  invalidated acceptance decision. Plan changes are commands, never replacement
  snapshots. Detach does not launch, resume, or prove completion of any process.

## Development

Run unit tests and lint locally:

```bash
npm test
npm run lint
```

Run the real end-to-end suite from inside herdr with an explicit test model:

```bash
PI_TEST_MODEL="deepseek/deepseek-v4-flash" PI_TEST_TIMEOUT=180000 npm run test:integration
```

The full suite launches real Pi sessions and can take several minutes. `PI_TEST_TIMEOUT` is the per-test timeout in milliseconds; use at least `180000` for the lifecycle suite.

`PI_TEST_MODEL` is applied to both the parent Pi sessions and the project-local test subagents created by the harness.

## Install

Install the package from npm:

```bash
pi install npm:pi-herdr-subagents
```

This project does not install or load `HazAT/pi-interactive-subagents` automatically.

Changing the `package.json` version on `main` automatically creates a matching Git tag and GitHub Release, generates release notes, and publishes the package to npm. For authentication, versioning, verification, and troubleshooting, see [RELEASING.md](RELEASING.md).

Start herdr, then run pi inside it:

```bash
herdr
pi
```

The extension supports two terminal backends:

- **Legacy herdr:** the `herdr` CLI with its `pane`/`tab` API and `HERDR_ENV=1`.
- **herdr-core (`hc`, verified with 0.1.18):** `HC_TERMINAL_ID` and `HC_TERMINAL_SOCKET` identify the parent terminal. The adapter resolves `hc` from PATH, or the standard per-user Windows installation at `%LOCALAPPDATA%/Programs/herdr-core/hc.exe`. No alias or fabricated `HERDR_ENV` is needed.

The hc backend creates explicitly targeted Bash terminals with native parent notifications disabled (the extension delivers results itself). Bash must be on the orchestrator's PATH or in a standard Git for Windows installation (`ProgramFiles/Git`, `ProgramFiles(x86)/Git`, or `LOCALAPPDATA/Programs/Git`). Pi's Bash tool can add Git to its child PATH even when extension callbacks cannot see it; the adapter therefore resolves Bash separately and adds Git's shell utilities to the launch-script PATH. Scripts also preserve the orchestrator's tool PATH, including Pi and Node. This does not install Bash or any other dependency. hc does not expose the legacy app layout API: tab/split requests create separate terminals instead, tab renaming sets a `pi.name` label, and workspace renaming is unsupported. Visual placement is managed by the herdr app, not guaranteed by this adapter.

To orchestrate from a plain terminal while herdr runs in the background, set `environment.allowOutsideHerdr` to `true` in `config.json`. A compatible CLI and reachable server are still required. See [Configuration](#configuration). After modifying an already loaded extension, use `/reload` in Pi.

A synthetic live adapter check (creates and removes one terminal, no model calls) is available alongside the unit tests:

```bash
node --test test/hc.test.ts
PI_TEST_HC_LIVE=1 node --test test/hc-live.test.ts
```

In PowerShell, set `$env:PI_TEST_HC_LIVE = '1'` before the second command. This check covers launch-script execution, Pi/Node PATH resolution, inspection, sync/async reads, Escape delivery, and terminal cleanup. It does not establish AI-provider authentication or a complete subagent round trip.

If your shell startup is slow and subagent commands sometimes get dropped before the prompt is ready, set `PI_SUBAGENT_SHELL_READY_DELAY_MS` to a higher value (defaults to `500`):

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500
```

By default each subagent runs in its **own new tab**. If you'd rather keep them
side-by-side with the orchestrator, set `PI_SUBAGENT_LAYOUT=split` (right-hand
split) or `PI_SUBAGENT_LAYOUT=split:down` (split below). Unset, empty, or any
other value keeps the default new-tab behavior:

```bash
export PI_SUBAGENT_LAYOUT=split        # right-hand split
# export PI_SUBAGENT_LAYOUT=split:down # split below
```

Subagent tabs and panes are created without stealing keyboard focus. Launch commands target child panes by explicit ID, so focus and command delivery are independent. Note: the `interactive` option is retained as metadata, not terminal focus or permission to wake on progress.

## What's Included

### Extensions

**Subagents** — 4 main-session tools + 3 commands, plus 1 subagent-only tool:

| Tool                 | Description                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `subagent`           | Spawn a sub-agent in a dedicated herdr pane (async — returns immediately)             |
| `subagent_interrupt` | Interrupt a running Pi-backed subagent's current turn                                       |
| `subagents_list`     | List available agent definitions                                                            |
| `subagent_resume`    | Resume a previous sub-agent session (async)                                                 |
| `subagent_audit`     | Read-only canonical session OS process audit (Windows/Linux)                                 |
| `subagent_close`     | Request owned idle Pi shutdown; verify original PID + birth exited                           |

| Command                    | Description                          |
| -------------------------- | ------------------------------------ |
| `/plan`                    | Start a full planning workflow       |
| `/iterate`                 | Fork into a subagent for quick fixes |
| `/subagent <agent> <task>` | Spawn a named agent directly         |

### Bundled Agents

| Agent             | Default runtime       | Role                                                                                     |
| ----------------- | --------------------- | ---------------------------------------------------------------------------------------- |
| **planner**       | Config, then parent   | Brainstorming — clarifies requirements, explores approaches, writes plans, creates todos |
| **scout**         | Config, then parent   | Fast codebase reconnaissance — maps files, patterns, conventions                         |
| **worker**        | Config, then parent   | Implements tasks from todos — writes code, runs tests, makes polished commits            |
| **reviewer**      | Config, then parent   | Reviews code for bugs, security issues, correctness                                      |
| **visual-tester** | Config, then parent   | Visual QA via Chrome CDP — screenshots, responsive testing, interaction testing          |

Bundled agents use model defaults from `config.json` when configured; otherwise they inherit the parent model. Thinking defaults still come from agent frontmatter or the parent level. For a named agent, callers should omit `model` and `thinking` so those configured defaults apply. Passing either field explicitly is a one-off override and takes precedence over agent frontmatter.

Agent discovery follows priority: **project-local** (`.pi/agents/`) > **global** (`~/.pi/agent/agents/`) > **package-bundled**. Override any bundled agent by placing your own version in the higher-priority location. The discovered names, descriptions, and runtime defaults are included in the subagent tool guidance so the orchestrator can select by role instead of treating one agent as a generic default.

### Supported Harness CLIs

Agents default to running with `pi`, but can run inside any supported harness CLI or custom CLI configured via agent frontmatter:

| Harness CLI | Frontmatter `cli:` | Model format | Notes |
| :--- | :--- | :--- | :--- |
| **Pi** (default) | `pi` (or omitted) | `provider/model` | Full support for thinking levels, turn interrupts, and live activity snapshots |
| **OpenCode** | `opencode` | `provider/model` | Runs `opencode run --model <model> <task>` |
| **Codex** | `codex` | bare model ID | Runs `codex --model <model>` with optional `--reasoning-effort` |
| **Claude Code** | `claude` | bare model ID | Runs `claude --model <model>` with autonomous completion hook |
| **Grok** | `grok` | bare model ID | Runs `grok --model <model> <task>` |
| **Custom / Generic** | any CLI name | bare model ID | Supports custom `command:` template (e.g. `command: "aider --model {model} --message {task}"`) |

Claude Code completion follows the resolved `auto-exit` setting. For autonomous
runs, its Stop hook publishes the final response even when `--resume` loads prior
user messages or additional input was sent during the task. Non-auto-exit runs
remain open until the Claude CLI exits; `interactive` remains independent metadata; observed status changes are panel-only. The hook uses `last_assistant_message` when available and
falls back to the last 4 MiB of transcript text on older Claude versions. Completion is published
atomically, after saving the transcript pointer, so Pi cannot consume a partial
result. A temporarily missing transcript does not block completion.

---

## Async Subagent Flow

```
1. Agent calls subagent()          → returns immediately ("started")
2. Sub-agent runs in herdr pane    → widget shows live status
3. User keeps chatting             → main session fully interactive
4. Sub-agent finishes              → result steered back as a normal completion/failure
5. Main agent processes result     → continues with new context
```

Multiple subagents run concurrently — each steers its result back independently as it finishes. The live widget above the input tracks every agent still in flight:

```
╭─ Subagents ──────────────────── 1 active · 2 open ─╮
│ 01:23  Scout: Auth (scout)            active · write 7m │
│ 00:45  Researcher (researcher)               stalled 4m │
│ 00:12  Scout: DB (scout)                      starting… │
╰─────────────────────────────────────────────────────────╯
```

### Assignment and response entries

Pi child sessions start with a structured **Message from &lt;sender&gt;** card showing the sender, recipient, role, and full delegated task before the child begins work. This is a persisted display-only record: it does not send the task to the model a second time. In a full-context fork, inherited history stays before this first new entry. Resuming a session does not repeat its original assignment. Other harness CLIs retain their own prompt display.

When a child finishes, the main session receives a structured **Message from &lt;sender&gt;** card (using the same sender name and optional agent role as the **From** field) with sender, recipient, task, status, and the reply visible without expanding the entry. Additional session diagnostics remain expandable with `Ctrl+O`. This uses the existing asynchronous completion notification, not an extra message or model turn. Completed rows are removed from the widget as soon as their result is delivered or suppressed.

Both cards use rounded orange/amber borders matching the subagent status widget's frame, including failed responses. Full multiline content wraps to the terminal width; persisted cards retain this rendering on ordinary session resume.

### In-progress status updates

The widget projects each sub-agent from a **process + turn lifecycle**:

- **Herdr pane inspection** is the coarse authority for whether the child process is present and whether Herdr reports it as idle, working, blocked, or done.
- **Child activity snapshots** enrich the label with Pi-only detail (tool name, streaming, etc.) when available.
- Session JSONL is still used for transcript, resume, lineage, and result extraction — not for liveness.

Projected labels include:

- `starting` — launched; pane/activity confirmation is still settling
- `active` — processing work (agent turn, provider request, streaming, or tool execution)
- `blocked` — Herdr reports the child as blocked
- `waiting` — turn finished; the process is intentionally open for more input or another stage
- `interrupted` — the current turn was cancelled (Escape / `subagent_interrupt`); the process stays open and is **not** treated as active processing
- `stalled` — pane inspection is unhealthy long enough that the parent can no longer trust the run
- `running` — fallback when only coarse process presence is known (e.g. non-Pi backends)
- `finalizing` — completion was observed and delivery is in progress; the process elapsed timer freezes here

The widget header counts **active** vs **open**:

- **active** — `active`, `starting`, `running`, or `blocked`
- **open** — everything else still tracked (`waiting`, `interrupted`, `stalled`, `finalizing`, …)

When `activeCount === 0` (every tracked row is open), the border uses an amber accent. Process elapsed time (`MM:SS` on the left) freezes when the process reaches finalizing/completed/failed. Interrupt does **not** freeze that process clock; the interrupted state shows its own duration on the right while the process remains open.

A fixed internal watchdog marks a run as `stalled` when pane inspection fails or the pane disappears without a completion sidecar; valid long-running `active` or `waiting` states do not become `stalled` just because time passes. All observed transitions, including `stalled` and recovery, stay in the existing process widget. Ordinary progress never creates a status-message stream or an extra parent turn. A watcher/provider error or explicit child help request is different: it still wakes the parent through the completion outbox.

**Autonomous and interactive subagents are equally quiet for observations.** The widget still refreshes and snapshots are still classified regardless of `interactive`. The compatibility flag retains its frontmatter/per-spawn defaults, but no longer opts autonomous agents into stall pings. This does not suppress results, explicit `caller_ping`, errors, keepOpen follow-up results or retry/recovery handoffs.

#### Configuration

Status display is controlled by `config.json` in the extension directory. Copy `config.json.example` to get started:

```bash
cp config.json.example config.json
```

```json
{
  "status": {
    "enabled": true
  },
  "models": {
    "agents": {}
  },
  "environment": {
    "allowOutsideHerdr": false
  },
  "behavior": {
    "closeOnDone": true
  }
}
```

The copyable example is model-neutral, so it works without requiring credentials for a specific provider. To configure models, replace the empty section with exact IDs from your authenticated model catalog:

```json
{
  "models": {
    "default": "your-provider/your-default-model",
    "agents": {
      "scout": "your-provider/your-fast-model",
      "reviewer": "your-provider/your-review-model"
    }
  }
}
```

`models.default` sets the model for subagents that do not specify a model. `models.agents` sets per-agent defaults, keyed by the agent name passed to `subagent({ agent: ... })`. Explicit `model` tool arguments take precedence, followed by agent frontmatter, per-agent config, the global default, and finally the parent model. Model values must be exact authenticated `provider/model-id` references.

`environment.allowOutsideHerdr` lifts the inside-herdr requirement. When `true`, the extension accepts a session running in any terminal as long as a compatible CLI exists and its server responds (`herdr workspace list`, or `hc server status` when the legacy CLI is absent). With legacy herdr, subagent tabs are created in the first workspace when the current pane cannot be resolved. Split layouts need a parent pane, so they fall back to a new tab when running outside herdr. With hc, launches always create separate terminals; app workspace/split placement is not controlled. Defaults to `false`, which keeps the fail-fast setup hint for new users.

`behavior.closeOnDone` sets the default for what happens to a subagent's pane after its result is delivered. `true` closes the pane as before. `false` leaves the pane and its pi session open so you can continue the conversation in place. A subagent can override the default per call with `subagent_done({ close: false })` or `subagent_done({ close: true })`. The parent retains supervision and can use `subagent_resume` with a message to continue the same live Pi process.

`config.json` is gitignored so local overrides don't get committed.

---

## Notification policy

Plan mutations and active-branch restoration refresh the native plan widget directly from the store. Process/activity refresh uses the process widget. Neither UI path sends a model message or schedules an extra model turn; a tool's normal response is not an additional notification. Widgets are presentation, not model context: the existing `context` hook projects the current plan on the next naturally required model request, without starting one.

The centralized `notification-policy.ts` gates the production completion outbox: results, explicit help/blockers, questions, errors and required decisions wake the immediate parent (`triggerTurn:true`, `deliverAs:"steer"`). Classification uses event types/structured error fields, never words in a progress message. Unknown/progress events cannot enter the waking outbox. Question/decision event categories reserve policy vocabulary only; they do not add a child tool or protocol. Existing durable retry, deduplication and UNKNOWN-handoff recovery semantics remain unchanged.

## Spawning Subagents

```typescript
// Named agent with defaults from agent definition or config.json
subagent({ name: "Scout", agent: "scout", task: "Analyze the codebase..." });

// Force a full-context fork for this spawn
subagent({ name: "Iterate", fork: true, task: "Fix the bug where..." });

// Agent defaults can choose a different session-mode via frontmatter
subagent({ name: "Planner", agent: "planner", task: "Work through the design with me" });

// Custom working directory
subagent({ name: "Designer", agent: "game-designer", cwd: "agents/game-designer", task: "..." });
```

### Parameters

| Parameter              | Type    | Default        | Description                                                                                       |
| ---------------------- | ------- | -------------- | ------------------------------------------------------------------------------------------------- |
| `name`                 | string  | required       | Display name (shown in widget and pane title)                                                     |
| `task`                 | string  | required       | Task prompt for the sub-agent                                                                     |
| `agent`                | string  | —              | Load defaults from agent definition                                                               |
| `fork`                 | boolean | `false`        | Force the full-context fork mode for this spawn, overriding any agent `session-mode` frontmatter  |
| `interactive`          | boolean | derived        | Interactive metadata (observed stall/recovery is panel-only for every spawn). Defaults to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit`. |
| `model`                | string  | agent, configured, or parent | Exact authenticated `provider/model-id`; resolution is tool argument → agent frontmatter → per-agent config → global config → parent |
| `thinking`             | string  | agent or parent | Pi thinking level (`off` through `max`); resolution is tool argument → agent frontmatter → parent |
| `systemPrompt`         | string  | —              | Append to system prompt                                                                           |
| `skills`               | string  | —              | Comma-separated skill names                                                                       |
| `tools`                | string  | —              | Comma-separated tool names                                                                        |
| `cwd`                  | string  | —              | Working directory for the sub-agent (see [Role Folders](#role-folders))                           |

---

## Interrupting a running subagent

Use `subagent_interrupt` to cancel the active turn of a running Pi-backed subagent:

```typescript
subagent_interrupt({ id: "abcd1234" });
// or
subagent_interrupt({ name: "Scout" });
```

This sends Escape to the child pane, cancelling the in-progress model turn. The subagent session stays alive — the pane, session file, and background polling all remain intact. After the interrupt, the widget immediately labels the child as `interrupted` (counted as **open**, not active processing). Stale pre-interrupt activity snapshots are ignored so a lagging Herdr/`active` reading cannot overwrite the interrupt. The process elapsed timer keeps running because the pane is still open; only the interrupted-state duration freezes relative to the interrupt request. If the child starts work later, newer observations return it to `active`; completion, failure, and `caller_ping` still flow through normally.

This is a turn-level interrupt, not a method for forcibly terminating a subagent session.

> **Note:** Only Pi-backed subagents are supported. Claude-backed runs will return an error.

---

## Keeping a subagent pane open after completion

A subagent finishes by calling `subagent_done`, and the parent closes its pane after delivering the result. To keep the pane and its session alive for a follow-up question, pass `close: false`:

```typescript
subagent_done({ close: false });
```

The result is still delivered to the parent as a steer message. The pane stays open and idle, so the next message can continue the same conversation in place. The orchestrator can use `subagent_resume` with a message to continue that same live process without starting another pane. Omitting `close` uses `behavior.closeOnDone` from `config.json`, which defaults to `true`.

---

## caller_ping — Child-to-Parent Help Request

The `caller_ping` tool lets a subagent request help from its parent agent. When called, the child session **exits** and the parent receives a notification with the help message. The parent can then **resume** the child session with a response using `subagent_resume`.

**`caller_ping` parameters:**
- `message` (required): What you need help with

**`subagent_resume` parameters:**
- `sessionPath` (required): Path to the child session `.jsonl` file
- `name` (optional): Display name for a new resumed pane (defaults to `Resume`); a live child must retain its name.
- `message`: Follow-up prompt; required and nonempty for live continuation, optional for closed-session resume.
- `autoExit` (optional): Must match the saved launch profile; omission preserves it.

For an owned, tracked Pi child interrupted with Escape, resume continues the **same process, run, pane and watcher** only after the child confirms `agent_settled` with an aborted run and idle state. Active, starting, finalizing or unknown states reject. The launch configuration is unchanged. The child advertises `artifact-v1` continuation support and watches its run-specific request directory from `session_start` until shutdown/reload. After binding/custody validation, the parent atomically publishes a UUID/run/session/idle-token-bound request; the child passes the exact follow-up to `sendUserMessage` with template/command expansion disabled (not terminal/shell input or `@file` expansion). HC `idle` or `done` is only coarse pane evidence: a fresh child-issued settled token is also required. Unsupported legacy children fail with update/reload guidance; no blind terminal fallback is attempted.

A durable claim, separate from the immutable acceptance/rejection acknowledgement, deduplicates requests across reloads. These artifacts share the local OS/filesystem trust boundary; they do not authenticate against a malicious same-user process. A transport timeout or ambiguous dispatch returns `pending`, retains the in-flight reservation and never starts a replacement process; do not retry that continuation. This is a conservative synchronous API-dispatch acknowledgement, not proof that the provider processed the prompt. Unowned closed Pi sessions still use the saved-profile launch path. The same guarded transport supports tracked keep-open children after their completed turn and settled-idle acknowledgement.

### Read-only session process audit

`subagent_audit({sessionPath: "/absolute/path/child.jsonl"})` reports OS-visible Pi CLI owners of the canonical file, including symlink aliases. Alternatively supply an owned `id` or exact `name` (not both selectors). Output is bounded to 32 PID + process-birth identities; command lines and credentials are never returned. Multiple owners report `duplicate`; denied enumeration, unresolved relative paths/UUID selectors and unsupported platforms report uncertainty, never an empty safe result. Windows and Linux are supported. This is a point-in-time CLI audit, not a global lock: manual session switches inside Pi and writers that do not explicitly select `--session` are outside its coverage.

Resume audits before terminal/task writes and again after asynchronous inspection. A sole matching tracked live owner may continue; untracked/duplicate or unverified writers block relaunch with manual cleanup guidance. Three legacy Pi instances may legitimately be found sharing a file after old resumes: audit does **not** close them automatically. Completion is not process exit, and `close:false` remains intentional. No stale PID, idle state or model claim authorizes termination.

### Explicit verified close

```js
subagent_audit({ sessionPath: "/absolute/path/child.jsonl" })
subagent_close({ id: "owned-run-id" }) // alternatively exact owned name
```

`subagent_close` is a parent-owned lifecycle tool, not a child completion tool. It accepts only a tracked owned Pi child, honors `deny-tools` and `spawning:false`, and is **not** automatically added to child tool allowlists. No arbitrary session path, force option, cancellation, process-name kill, terminal typing or legacy cleanup is supported. Duplicate owners or uncertain OS/ancestry evidence refuse a new shutdown request. Recovered artifact-only children with detached terminal custody remain ineligible; update/reload legacy children and complete a turn, or close them manually.

The separate `close-v1` artifact capability binds requests to the run, canonical session, process birth/nonce and a fresh child-issued settled-idle token. The child rechecks current session, idle state and pending input, durably claims the UUID, publishes an immutable acknowledgement, and calls Pi's graceful `ctx.shutdown()` without another model turn. Watchers start on `session_start` and stop on `session_shutdown`; reload invalidates old idle proofs. Acknowledgement means **requested**, never exited. RPC mode applies shutdown at its next command-response boundary; without that boundary it may remain pending.

Only an OS probe showing the original PID + birth absent (including PID reuse) yields `closed`. This describes **that owned process**, not every writer of the session; remaining/unverified owners are reported. A timeout or unavailable probe returns `pending`/`uncertain` and retains ownership and the close request. Recheck the same id; do not resume or launch a replacement. Replay/reload does not dispatch again. A rejected request is retained rather than silently retried with a new idle token; inspect/close manually. Branch, binding and durable custody are revalidated after waits. Ancestry gaps (for example exited Windows launchers) fail closed unless direct-child identity proves non-ancestry. No reused PID or pane is killed/closed by this tool. Successful original-process receipts remain read-only across extension reload (bounded to 128); parent restart does not adopt legacy controls.

`subagent_done({close:false})` still intentionally keeps collaboration open. Completion, assistant claims, stale PIDs and idle observations never trigger automatic cleanup. Existing owned-pane supervision remains independent of the explicit close handshake.

### Nonclosing question/progress channel: considered and deferred

A dedicated nonclosing question channel could preserve a worker's pane while the parent decides, but it is **not implemented**. `caller_ping` still exits; it must not be advertised as a pause-and-wait tool. Ordinary progress belongs in the existing panel, not a new tool or wakeup protocol.

The existing guarded live continuation is a prerequisite, not a complete question protocol: it requires a tracked Pi owner and run-bound settled-idle acknowledgement, reserves dispatch, deduplicates request IDs, disables prompt expansion, and fails closed on ambiguous transport or recovered artifact-only custody. A future question channel would additionally need explicit question/answer correlation, persistent blocked state, cancellation/late-answer rules, authority checks and safe handling of concurrent manual input/reload/restart. Until those semantics have dedicated tests, use exiting `caller_ping` for help and `subagent_resume` under its existing guards; use keepOpen for already-supported settled-turn collaboration. No speculative question/progress tool is registered by this policy change.

### Chosen keep-open semantics

`keepOpen` is defined as **tracked ongoing collaboration**, not a one-time
terminal handoff. Each completed turn publishes a distinct result to its immediate
parent while preserving session ownership and the watcher. Manual pane input and
`subagent_resume` follow-ups both retain tracking. Once `close:false` opts the
session into collaboration, later settled turns stay open even if the initial
`closeOnDone` default was true; use explicit `close:true` to close it. Idle children count as open,
not active, in the widget. `subagent_done({close:true})`, `/exit`, or confirmed
pane disappearance ends supervision; turn completion alone never releases ownership.
There is no explicit terminal-handoff API in this version.

Tracked keep-open is **Pi-only** (`supportsTrackedKeepOpen`). Other harnesses do
not support this repeated-result/live-follow-up contract; `behavior.closeOnDone`
and Pi's `subagent_done` do not give them that capability. Each Pi completion has
a run/turn event identity and immutable result snapshot; failed parent notifications
remain in the durable outbox across subsequent turns, `/reload` and parent restart.
Handoff means normal synchronous `sendMessage` return, not exactly-once execution.
Restart recovery is artifact-only after identity verification, never automatic
relaunch or reuse of a saved pane (see Result delivery boundary above).

**Interaction flow:**
1. Child calls `caller_ping({ message: "Not sure which schema to use" })`
2. Child session exits (like `subagent_done`)
3. Parent receives a steer notification: *"Sub-agent Worker needs help: Not sure which schema to use"*
4. Parent resumes the child session via `subagent_resume` with the response
5. Child picks up where it left off with the parent's guidance

**Example:**
```typescript
// Inside a worker subagent
await caller_ping({
  message: "Found two conflicting migration files — should I use v1 or v2?"
});
// Session exits here. Parent receives the ping, then resumes this session
// with guidance like "Use v2, v1 is deprecated"
```

> **Note:** `caller_ping` is only available inside subagent contexts. Calling it from a standalone pi session returns an error.

---

## The `/plan` Workflow

The `/plan` command orchestrates a full planning-to-implementation pipeline.

```
/plan Add a dark mode toggle to the settings page
```

```
Phase 1: Investigation    → Quick codebase scan
Phase 2: Planning         → Interactive planner subagent (user collaborates)
Phase 3: Review Plan      → Confirm todos, adjust if needed
Phase 4: Execute          → Scout + sequential workers implement todos
Phase 5: Review           → Reviewer subagent checks all changes
```

The parent workspace and tab names stay unchanged. Subagents are created in newly named tabs or panes for each phase.

---

## The `/iterate` Workflow

For quick, focused work without polluting the main session's context.

```
/iterate Fix the off-by-one error in the pagination logic
```

This always forks the current session into a subagent with full conversation context. It does not inherit an agent default `session-mode`. Make the fix, verify it, and exit to return. The main session gets a summary of what was done.

---

## Custom Agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Keep the filename and frontmatter `name` aligned (for example, `researcher.md` must declare `name: researcher`) so discovery and direct invocation agree:

```markdown
---
name: my-agent
description: Does something specific
model: anthropic/claude-sonnet-4-6
thinking: minimal
tools: read, bash, edit, write
session-mode: lineage-only
spawning: false
---

# My Agent

You are a specialized agent that does X...
```

### Frontmatter Reference

| Field         | Type    | Description                                                                                                                                                                                                                                                                 |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string  | Agent name (used in `agent: "my-agent"`)                                                                                                                                                                                                                                    |
| `description` | string  | Shown in `subagents_list` output                                                                                                                                                                                                                                            |
| `model`       | string  | Optional exact authenticated model default; omit to inherit the parent                                                                                                                                                                                                      |
| `thinking`    | string  | Optional Pi thinking default (`off` through `max`); omit to inherit the parent                                                                                                                                                                                                                                 |
| `tools`       | string  | Comma-separated **native pi tools only**: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`                                                                                                                                                                             |
| `skills`      | string  | Comma-separated skill names to auto-load                                                                                                                                                                                                                                    |
| `session-mode` | string | Default child-session mode: `standalone`, `lineage-only`, or `fork` |
| `spawning`    | boolean | Set `false` to deny all subagent-spawning tools                                                                                                                                                                                                                             |
| `deny-tools`  | string  | Comma-separated extension tool names to deny                                                                                                                                                                                                                                |
| `auto-exit`   | boolean | Automatically complete the run after a final response — no `subagent_done` call needed. Recommended for autonomous agents (scout, worker); not for interactive ones (planner). Claude uses its Stop hook; Pi uses its settled lifecycle. Also determines the default value of `interactive` (see below). |
| `interactive` | boolean | derived        | Compatibility metadata, defaulting to the inverse of `auto-exit`. Explicit values take precedence. Observed stall/recovery never wakes the parent, regardless of this flag. |
| `cwd`         | string  | Default working directory (absolute or relative to project root)                                                                                                                                                                                                            |
| `disable-model-invocation` | boolean | Hide this agent from discovery surfaces like `subagents_list`. The agent still remains directly invokable by explicit name via `subagent({ agent: "name", ... })`. |

---

Discovery still resolves precedence before visibility filtering. If a project-local hidden agent has the same name as a visible global or bundled agent, the hidden project agent wins and the lower-precedence agent does not appear in `subagents_list`.

### `session-mode`

Choose how a subagent session starts:

- `standalone` — default fresh session with no lineage link to the caller
- `lineage-only` — fresh blank child session with `parentSession` linkage, but no copied turns from the caller
- `fork` — linked child session seeded with the caller's prior conversation context

`lineage-only` is useful when you want session discovery and fork lineage UX to show the relationship later, but you do **not** want the child to inherit the parent's turns.

`fork: true` on the tool call always forces the `fork` mode for that specific spawn. `/iterate` uses this explicit override on purpose.

Pi supports all three modes by loading the selected session file. Claude, Codex, OpenCode, Grok, and generic command templates support only `standalone`: they do not consume seeded Pi JSONL. Requesting `lineage-only` or `fork` with those harnesses fails before creating a pane or session artifacts; it never silently drops the requested transfer.

`resumeSessionId` is a separate native-harness operation, supported only by Claude (`--resume`) and OpenCode (`--session`). It cannot be combined with Pi session transfer. Other harnesses reject it instead of ignoring it; use `subagent_resume` for Pi session-file resume. Turn-only interrupts and structured activity snapshots remain Pi-only.

```yaml
---
name: planner
session-mode: lineage-only
---
```

### `auto-exit`

When set to `true`, the agent session shuts down automatically as soon as the agent finishes its turn — no explicit `subagent_done` call is needed.

**Behavior:**

- Pi-backed sessions close after a normal final response once the run has settled; tool-use and aborted turns do not auto-exit
- Claude-backed sessions signal completion at the final Stop hook, regardless of historical or additional user messages; use `auto-exit: false` for a user-driven session
- The modeHint injected into the agent's task is adjusted accordingly: autonomous agents see "Complete your task autonomously." rather than instructions to call `subagent_done`

**When to use:**

- ✅ Autonomous agents (scout, worker, reviewer) that run to completion
- ❌ Interactive agents (planner, iterate) where the user drives the session

```yaml
---
name: scout
auto-exit: true
---
```

### `interactive`

Retained compatibility metadata for user-driven sessions. It no longer controls parent wakeups: status transitions (`stalled`, `recovered`) are panel-only for all agents.

**Default:** the inverse of `auto-exit`. Bare spawns with no agent definitions (e.g. `/iterate` with `fork: true`) are interactive. Frontmatter and per-spawn overrides still parse, but neither value enables stall pings. Results/help/errors remain actionable regardless of this flag.

```yaml
---
name: planner
# interactive defaults to true because auto-exit is not set
---
```

Or per spawn:

```typescript
subagent({ name: "Scout", agent: "scout", interactive: true, task: "..." });
```

---

## Tool Access Control

By default, every sub-agent can spawn further sub-agents. Control this with frontmatter:

### `spawning: false`

Denies all subagent lifecycle tools (`subagent`, `subagent_interrupt`, `subagents_list`, `subagent_resume`, `subagent_close`; read-only `subagent_audit` remains available):

```yaml
---
name: worker
spawning: false
---
```

### `deny-tools`

Fine-grained control over individual extension tools:

```yaml
---
name: focused-agent
deny-tools: subagent
---
```

### Recommended Configuration

| Agent      | `spawning`  | Rationale                                    |
| ---------- | ----------- | -------------------------------------------- |
| planner    | _(default)_ | Legitimately spawns scouts for investigation |
| worker     | `false`     | Should implement tasks, not delegate         |
| researcher | `false`     | Should research, not spawn                   |
| reviewer   | `false`     | Should review, not spawn                     |
| scout      | `false`     | Should gather context, not spawn             |

---

## Role Folders

The `cwd` parameter lets sub-agents start in a specific directory with its own configuration:

```
project/
├── agents/
│   ├── game-designer/
│   │   └── CLAUDE.md          ← "You are a game designer..."
│   ├── sre/
│   │   ├── CLAUDE.md          ← "You are an SRE specialist..."
│   │   └── .pi/skills/        ← SRE-specific skills
│   └── narrative/
│       └── CLAUDE.md          ← "You are a narrative designer..."
```

```typescript
subagent({ name: "Game Designer", cwd: "agents/game-designer", task: "Design the combat system" });
subagent({ name: "SRE", cwd: "agents/sre", task: "Review deployment pipeline" });
```

Set a default `cwd` in agent frontmatter:

```yaml
---
name: game-designer
cwd: ./agents/game-designer
spawning: false
---
```

---

## Tools Widget

Every sub-agent session displays a compact tools widget showing available and denied tools. Toggle with `Ctrl+J`:

```
[scout] — 12 tools · 4 denied  (Ctrl+J)              ← collapsed
[scout] — 12 available  (Ctrl+J to collapse)          ← expanded
  read, bash, edit, write, todo, ...
  denied: subagent, subagents_list, ...
```

---

## Requirements

- [pi](https://github.com/earendil-works/pi) 1.3.x, minimum 1.3.0. The extension is tested on this line only.
- [herdr](https://herdr.dev) — the required terminal workspace

```bash
herdr
pi
```

Other multiplexers and terminal backends are not supported.

---

## Acknowledgements

The sub-agent status supervision and turn-only interruption features were inspired by [RepoPrompt](https://repoprompt.com/)'s sub-agent snapshot polling and run cancellation features.

---

## License

MIT
