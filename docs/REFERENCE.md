# pi-herdr-subagents reference

[Quick start](../README.md) · [Installation and terminal backends](#install) · [Spawning](#spawning-subagents) · [Durable plans](#durable-task-plans-pi) · [Configuration](#configuration) · [Custom agents](#custom-agents) · [Development](#development)

## Install

Install the package from npm:

```bash
pi install npm:pi-herdr-subagents
```

This project does not install or load `HazAT/pi-interactive-subagents` automatically.

Changing the `package.json` version on `main` automatically creates a matching Git tag and GitHub Release, generates release notes, and publishes the package to npm. For authentication, versioning, verification, and troubleshooting, see [RELEASING.md](https://github.com/gszczutkowski/pi-herdr-subagents/blob/main/RELEASING.md).

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

`/subagents-tree` opens an amber-framed history widget on demand, even when
there is no saved history on the current branch. Use `expand`, `compact`,
`toggle <sessionId>`, `refresh` or `off` (dismiss). Expanded nodes show the last
three bounded explicit events. The tree caps sessions at 200, depth at 16 and
output at 120 width-aware lines; malformed cycles/disconnected components cannot
recurse indefinitely. It is a history view, not liveness or terminal controls.
The tree and its file watchers stay off until opened in the TUI. Closing the
widget or shutting down the session stops its watchers. Unsupported/missing
filesystem watch support falls back to command/tool refresh. Refresh does not
start a model turn. Other UI modes receive command summaries, while print mode
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
OS supports them. On Windows only, a manifest replacement returning `EPERM` or
`EBUSY` gets up to three retries of the same closed temporary file (10, 30, 60 ms),
with custody rechecked before each retry. Neither the launch nor terminal send is
retried. These error codes alone do not identify what denied the replacement.
A writer lease excludes simultaneous parents; corrupt or future schemas fail
closed rather than resetting state.

Synchronous throws retain the original envelope for bounded-backoff retries.
Outbox `dispatching` is persisted before `sendMessage`, and `handedOff` afterward.
A crash between them is UNKNOWN, not permission to resend. Tombstones are retained.
Storage/custody failures park delivery with per-event stage/error diagnostics in
`/subagents-recovery`. After fixing storage, `/subagents-reconcile` can recover up
to 100 proven-unsent pre-send failures per call, only under current writer/branch
custody with the identical durable `pending` envelope. It never replays UNKNOWN
`dispatching` events or post-send failures, and never starts another child turn.
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
must not close a potentially reused pane. There is currently no automatic or
built-in force-resolution of those decisions. No live terminal-recovery E2E
guarantee is made.

After terminal loss, **resume the original saved parent session and branch**.
Startup announces recorded assignments, including runs with no plan binding.
After reviewing `/subagents-recovery`, use `/subagents-recovery-ack` to dismiss
that startup notice for the current branch and saved state. The acknowledgement
survives `/reload` and restarting Pi; new assignments or changes in reconciliation,
delivery, or diagnostics bring the notice back. Acknowledgement is unavailable
when the saved view is blocked or storage is uncertain. It neither removes
history nor accepts results, repairs metadata, or controls children.
A bounded native context publication (4KB maximum) still makes assignments visible
at an existing agent/turn boundary, without starting a turn. A read-only
post-compaction fallback preserves visibility until the next durable boundary. Use
`/subagents-recovery [runId]` or `subagents_recovery({})` for the read-only report.
The tool accepts `{ offset, limit }` (default 10, maximum 20) or `{ runId }` for
detail, capped at 24KB with explicitly truncated fields. Detail includes the
first ten retained delivery excerpts. List pages give the next offset.

If both launch and failure-evidence commits fail, an independent immutable record
in `subagent-runtime/dispatch-evidence/` retains the run ID, original plan binding
(if any), phase and cause, but not the task or prompt. If that write also fails,
`memory-only` means the record can survive `/reload`, not process exit. Reconcile
from the original parent branch: users type `/subagents-reconcile` in the Pi TUI;
agents call `subagents_reconcile({})`. Nested coordinators can reconcile their
own children, never an ancestor's manifest; the same session/branch custody guards
apply. Sending slash-command text via an external terminal transport is not a
substitute for either interface. Unreadable journal evidence and failed metadata
writes can block writer generation rollover. If only the original plan binding is
unavailable, validated evidence for that exact run is retained in the manifest
across rotation; it remains blocked for that run without blocking unrelated
unbound launches. Repair still requires the original binding, nonconflicting
records, and current branch custody. `evidence=manifest` means the original
metadata was retained durably, not that it was imported or sent.

Reconciliation repairs metadata; it never dispatches a child command. Reports
separate storage errors from per-run outcomes. `resolved` with `before-send`
means the original run did not reach transport. `still-blocked` means a storage,
custody, or run-specific metadata check failed. `dispatch-unknown` means **do
not retry the resume**. A saved dispatch intent alone does not prove execution;
neither a pending or interrupted outbox handoff, watcher-only exit, new manifest
revision, nor another run's evidence resolves it. This also applies to older
plan-bound run IDs missing from the manifest without matching proof. A same-run,
same-session child completion (including a provider error) or a successfully
verified run-bound recovery challenge proves dispatch, not current liveness,
task success, or acceptance. Any subsequent continuation still requires an
explicit decision and fresh writer checks.

Reports show saved task/name/run ID/session path and **saved reconciliation, not
current liveness**. `pending` means retained for delivery, `unknown` means a
crash may have interrupted handoff, and `handedOff` acknowledges only the handoff
boundary. None means task acceptance. Review retained results and the original
assignment first, then audit current process/session writers before an explicit
`subagent_resume`. Reports never relaunch, resume, close panes, resend, acquire a
lease, or accept work. Branch mismatch, custody failure and recovery errors fail
closed with diagnostics; paused state does not grant control. Only this parent's
manifest is read, never unrelated sessions.

Terminal closure may kill the parent, children, or both. Saved assignments help
recover decisions; they do **not** guarantee processes or every result survive
terminal close. Legacy hosts without header/branch APIs report unavailable;
legacy/missing manifests cannot reconstruct old assignments or establish that no
unfinished work exists. Keep the original parent and child session artifacts.

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
criteria, attempts, results, evidence and decision history when they fit the
40,000-byte/2,000-line response budget. Larger reads return section navigation,
not truncated JSON or a request to repeat the same call:

- `plan_read({ taskId: "...", section: "results", limit: 50 })` reads results
  across all attempts, each with its `attemptId`. `runs` works the same way.
- Other task sections: `definition`, `criteria`, `dependencies`, `artifacts`,
  `attempts` (metadata/counts), `evidence`, `decisions`, `statusHistory`.
  `section: "tasks"` pages the plan overview and must omit `taskId`.
- Collection offsets are zero-based; limits default to 50, maximum 100. Follow
  `next` verbatim until null. Cursors pin `planId`/`expectedRevision`; restart the
  read if a concurrent update invalidates them. JSON continuations additionally
  carry `documentHash`: a restore/access/diagnostic change at the same revision
  rejects the old document cursor too. Do not remove fields from `next`.
- An oversized individual item provides `jsonRead`. `section: "json"` pages the
  complete view, including authority and full recovery diagnostics. Concatenate
  `jsonText` values, then parse JSON. Offsets/limits are UTF-16 string positions
  (not bytes or lines); the default limit is 4,096, maximum 8,192. With `taskId`
  the document contains only that task; without it, all full task records.
- Pages retain access/error/uncertainty indicators but are explicitly `partial`;
  they do not certify that the model has seen the complete plan context. No full
  snapshot is duplicated in their hidden tool details. Reads never grant writes.

`plan_update` takes
`expectedRevision` and a discriminated `command`: `create`, `add`, `edit`,
`attempt` (start/retry), `run`, `result`, `evidence`, `status`, `accept`, or `detach`.
Existing-plan commands also require `planId`. Criteria/artifact IDs are UUIDs.
Results require their original `{ sessionId, branchInstanceId }` authority.
Definition edits invalidate acceptance; acceptance requires evidence for every
criterion. These are parent commands, not worker-controlled snapshot replacement.
Mutations return compact planId/revision/authority and changed-task receipts,
including newly created IDs; they do not repeat every task's history. Full UI
details are retained; use an explicit read when missing details are needed.

Full validated immutable snapshots use native `pi-subagents-plan/v1` entries.
They survive terminal closure, reload, resume and native compaction. Only the
latest entry on `getBranch()` is authoritative, never the last physical JSONL
line. An actual persisted session with a user/assistant message is required:
`--no-session` and setup-only sessions cannot promise durability. Failed appends
disable writes across reload. Reopen the durable session, then call
`plan_read({ reconcile: true })`; an in-memory leaf ahead of disk is not trusted.
Unknown future plan schemas fail closed, never silently create an empty plan.
Malformed abandoned detach records cannot hide the valid selected snapshot:
rollback detection stays conservatively read-only until an explicit detach.
Only a fully validated detached alternative is exempt from that detection.

Restored `in_progress` tasks stay unchanged and are reported as
`recoveryUncertain`: persistence is not process-liveness or completion proof.
Read/update commands never launch work, accept it automatically or restore
runtime supervision. Native context publications read this same store at
existing agent/turn boundaries; a post-compaction fallback preserves exact state.
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
[assignment/result contracts](../CONTRACTS.md) for fields, bounds and the explicit
parent evidence/acceptance workflow.

The shared completion adapter imports the exact canonical delivery event ID.
Successful completion enters review, never acceptance; parent evidence can cite
that result ID and acceptance still requires criterion evidence and a parent
decision. Duplicate imports are idempotent; late events cannot reopen terminal
tasks. Import failure never suppresses the original result handoff: immutable
outbox envelopes (including handed-off ones) remain retry sources after reload
or recovery. Wrong-branch/origin imports are deferred, not redirected; select the
original branch and reconcile any plan storage fault. `/subagents-recovery`
shows bounded pending-import diagnostics but is read-only and does not retry
imports. Existing agent/turn boundaries retry pending imports **before** publishing
context; emergency post-compaction restoration retries immediately before its
read-only fallback. Ordinary request-time projection does not mutate the plan.
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
- `plan_read({ taskId: "..." })` provides structured task data in non-TUI modes
  too; large tasks use the collection/JSON pagination described above.

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

## What's Included

### Extensions

**Subagents** — selected tools and commands:

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
| **feature-coordinator** | Config, then parent | Pi-only, opt-in coordinator — delegates and verifies one feature without copying the parent's conversation |

Bundled agents use model defaults from `config.json` when configured; otherwise they inherit the parent model. Thinking defaults still come from agent frontmatter or the parent level. For a named agent, callers should omit `model` and `thinking` so those configured defaults apply. Passing either field explicitly is a one-off override and takes precedence over agent frontmatter.

Agent discovery follows priority: **explicitly authorized project-local** (`.pi/agents/`) > **global** (`~/.pi/agent/agents/`) > **package-bundled**. Project sources require the separate [source approval](#project-source-trust) below; merely selecting a `cwd` does not authorize executable configuration. The discovered names, descriptions, and runtime defaults are included in the subagent tool guidance so the orchestrator can select by role instead of treating one agent as a generic default.

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

Completing a turn with `close:false` (or `behavior.closeOnDone:false`) keeps activity reporting enabled for follow-up work. Child `/reload` continues the same run's last valid activity sequence, so fresh work can clear an interrupted label immediately. Completion artifacts take precedence over a shell exit marker, including artifacts published while the terminal read is in flight; provider failures and help requests must not be reduced to a successful process exit.

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

Plan mutations and active-branch restoration refresh the native plan widget directly from the store. Process/activity refresh uses the process widget. Neither UI path sends a model message or schedules an extra model turn; a tool's normal response is not an additional notification. Widgets are presentation, not model context: append-only native publications make changed plan/checkpoint/recovery state visible at existing agent/turn boundaries, without starting a turn. Visible receipts suppress duplicate publications. A narrow post-compaction fallback retains exact state when the host offers no durable pre-request boundary; that restoration can reset incremental transport continuation.

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

This requests Pi's public `ctx.abort()` through a child-issued `interrupt-v1` capability, not terminal keys or process signals. A fresh active token binds the run, canonical session/header and PID/birth identity; the child durably claims the request before aborting. The process, pane, session and result watcher remain alive. Parent custody and task binding are revalidated across asynchronous waits.

`interrupt_requested` acknowledges the child API request, **not** completed cancellation. `settlement: aborted` requires a separate correlated `agent_settled({ aborted: true })` artifact; otherwise settlement is `unconfirmed`. The widget's local interrupted marker is a request observation. Resume still requires the child's fresh settled-idle proof. Missing/expired capability, idle/legacy children and conflicting controls reject; uncertain acknowledgement returns `pending`. Never blindly retry or fall back to Escape, Ctrl+C or process termination. Claimed requests are not replayed after reload or storage/API ambiguity. Manual Escape is a separate Pi/terminal path, not what this tool sends.

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

The `caller_ping` tool lets a subagent request help from its parent agent. Normally the child session **exits** and the parent receives a notification with the help message. An explicit coordinator still supervising delegated work sends the notification but stays open to receive the remaining results. The parent can then **resume** the child session with a response using `subagent_resume`.

**`caller_ping` parameters:**
- `message` (required): What you need help with

**`subagent_resume` parameters:**
- `sessionPath` (required): Path to the child session `.jsonl` file
- `name` (optional): Display name for a new resumed pane (defaults to `Resume`); a live child must retain its name.
- `message`: Follow-up prompt; required and nonempty for live continuation, optional for closed-session resume.
- `autoExit` (optional): Must match the saved launch profile; omission preserves it.

A delegated Pi session can audit or resume only its **own direct Pi children** recorded under its current, active branch custody. Pass the original child's session path (or an owned live run ID/exact name for audit). An alias is accepted only if it resolves to the recorded canonical path; retargeting it to another session does not transfer authority. A saved launch profile, root-wide lineage history, or a shared working directory does not grant access. Once the manifest and path are authorized, the tool checks the first Pi JSONL header (bounded to 64 KiB) against the recorded child session ID before reading the profile or transcript body or enumerating writers. A replaced, missing, or invalid header fails closed; resume also checks it again during preparation and before dispatch. Closed children retain their direct-parent record in the manifest; after restart the existing recovery, process-verification, and launch-profile requirements still apply. A top-level Pi session retains arbitrary-session audit and the existing saved-profile resume behavior. This scopes extension tools, not the OS filesystem or shell.

For an owned, tracked Pi child interrupted through guarded abort or manual Escape, resume continues the **same process, run, pane and watcher** only after the child confirms `agent_settled` with an aborted run and idle state. Starting, finalizing or unknown states reject, as do actually busy children. A stale active parent observation after cancellation can be overridden only by a fresh child `interrupted-idle` token and confirmed idle pane; ordinary settled-idle evidence cannot override it. The launch configuration is unchanged. The child advertises `artifact-v1` continuation support and watches its run-specific request directory from `session_start` until shutdown/reload. After binding/custody validation, the parent atomically publishes a UUID/run/session/idle-token-bound request; the child passes the exact follow-up to `sendUserMessage` with template/command expansion disabled (not terminal/shell input or `@file` expansion). HC `idle` or `done` is only coarse pane evidence: a fresh child-issued settled token is also required. Unsupported legacy children fail with update/reload guidance; no blind terminal fallback is attempted.

A durable claim, separate from the immutable acceptance/rejection acknowledgement, deduplicates requests across reloads. These artifacts share the local OS/filesystem trust boundary; they do not authenticate against a malicious same-user process. A transport timeout or ambiguous dispatch returns `pending`, retains the in-flight reservation and never starts a replacement process; do not retry that continuation. This is a conservative synchronous API-dispatch acknowledgement, not proof that the provider processed the prompt. Unowned closed Pi sessions still use the saved-profile launch path. The same guarded transport supports tracked keep-open children after their completed turn and settled-idle acknowledgement.

### Read-only session process audit

`subagent_audit({sessionPath: "/absolute/path/child.jsonl"})` reports OS-visible Pi CLI owners of the canonical file, including symlink aliases. Alternatively supply an owned `id` or exact `name` (not both selectors). Output is bounded to 32 PID + process-birth identities; command lines and credentials are never returned. Multiple owners report `duplicate`; denied enumeration, unresolved relative paths/UUID selectors and unsupported platforms report uncertainty, never an empty safe result. Windows and Linux are supported. This is a point-in-time CLI audit, not a global lock: manual session switches inside Pi and writers that do not explicitly select `--session` are outside its coverage.

On Linux, native Pi sets `process.title`, which overwrites the original OS-visible command line and removes its `--session` selector. Such Node/Pi processes report `uncertain`, not known owners or `duplicate`; guarded resume and close remain blocked. An audit with zero known owners is **not** clearance when uncertainty is present. Readable complete command lines without a session selector are excluded before accessing potentially denied `/proc/<pid>/exe` links; denied or title-overwritten candidate evidence still fails closed.

Node entrypoints are resolved through real paths and the owning Pi package's declared `pi` bin (including bundled `dist/bundle/cli.js` and its exact shipped `dist/cli.js` companion), not filename substrings. Unrelated scripts with unknown Node VM flags do not contaminate the audit; ambiguous/denied script arguments still fail closed. Pi 1.5 does not parse `--session=path`; that spelling is reported uncertain, not clear.

Resume audits before terminal/task writes and again after asynchronous inspection. A sole matching tracked live owner may continue; untracked/duplicate or unverified writers block relaunch with manual cleanup guidance. Three legacy Pi instances may legitimately be found sharing a file after old resumes: audit does **not** close them automatically. Completion is not process exit, and `close:false` remains intentional. No stale PID, idle state or model claim authorizes termination.

### Explicit verified close

```js
subagent_audit({ sessionPath: "/absolute/path/child.jsonl" })
subagent_close({ id: "owned-run-id" }) // alternatively exact owned name
```

`subagent_close` is a parent-owned lifecycle tool, not a child completion tool. It accepts only a tracked owned Pi child, honors `deny-tools` and `spawning:false`, and is **not** automatically added to child tool allowlists. No arbitrary session path, force option, cancellation, process-name kill, terminal typing or legacy cleanup is supported. Duplicate owners or uncertain OS/ancestry evidence refuse a new shutdown request. Recovered artifact-only children with detached terminal custody remain ineligible; update/reload legacy children and complete a turn, or close them manually.

The separate `close-v1` artifact capability binds requests to the run, canonical session, process birth/nonce and a fresh child-issued settled-idle token. The child rechecks current session, idle state, pending input and the **current live editor** immediately before claiming the UUID. A draft typed after settlement rejects close; UI modes without a verifiable synchronous editor (including RPC's default getter) fail closed. With a safe editor it durably claims the UUID, publishes an immutable acknowledgement, and calls Pi's graceful `ctx.shutdown()` without another model turn. Watchers start on `session_start`, are unreferenced so SDK `dispose()` cannot keep a host alive, and close on `session_shutdown`/reload/error; reload invalidates old idle proofs. Acknowledgement means **requested**, never exited. RPC mode applies shutdown at its next command-response boundary; without that boundary it may remain pending.

Only an OS probe showing the original PID + birth absent (including PID reuse) yields `closed`. This describes **that owned process**, not every writer of the session; remaining/unverified owners are reported. A timeout or unavailable probe returns `pending`/`uncertain` and retains ownership and the close request. Recheck the same id; do not resume or launch a replacement. Replay/reload does not dispatch again. A definite non-dispatch rejection with matching run/session/process/nonce/request/idle identity and no durable claim clears **only that request's** close reservation and active intent. Immutable request/ack history and process ownership remain. Normal guarded continuation or an explicit fresh close after another settlement can proceed; requested, malformed, wrong-identity or ambiguous acknowledgements never unlock or replay. Branch, binding and durable custody are revalidated after waits. Exact live-map/owner identity is required until original PID + birth death is proven; only then may normal watcher removal of those original records be accepted. Replacement records are never adopted or released, even after original-process exit. After OS death, the registered tool gives normal supervision a bounded drain window before publishing its receipt, revalidating custody across every wait; map removal alone never proves exit. Ancestry gaps (for example exited Windows launchers) fail closed unless independent OS creation-time probes prove the target was born strictly after this parent Pi and therefore cannot be its ancestor. Equal/older/denied identities never authorize this exception; self/parent/observed ancestors remain protected. No reused PID or pane is killed/closed by this tool. Successful original-process receipts remain read-only across extension reload (bounded to 128); parent restart does not adopt legacy controls.

`subagent_done({close:false})` still intentionally keeps collaboration open. Completion, assistant claims, stale PIDs and idle observations never trigger automatic cleanup. Existing owned-pane supervision remains independent of the explicit close handshake.

**Parent cleanup policy:** after receiving a result and before reporting done, the
parent checks the current plan and concrete follow-ups for each owned idle child.
After preserving its result, it should use `subagent_close` if no pending review,
fixes, retry or other follow-up needs that child. Keeping a session open requires a
concrete reason recorded in the plan or final handoff, or an explicit user request;
"just in case" and unrelated unfinished tasks are not sufficient. A missing plan
or task binding alone is not disposal permission, and explicitly user-managed
interactive sessions require user authorization to close. Existing busy/draft/input,
ownership and custody checks remain authoritative. Unavailable/rejected/pending/
uncertain close states must be reported honestly, never bypassed with force-kill,
terminal typing or active-work interruption. This policy is delivered through the
active `subagent_close` tool's prompt guidelines and the planning completion
checklist; it is not a new background auto-close mechanism.

### Nonclosing question/progress channel: considered and deferred

A dedicated nonclosing question channel could preserve a worker's pane while the parent decides, but it is **not implemented**. `caller_ping` is not a general pause-and-wait tool: it exits unless an explicit coordinator still needs to receive a delegated result. Ordinary progress belongs in the existing panel, not a new tool or wakeup protocol.

The existing guarded live continuation is a prerequisite, not a complete question protocol: it requires a tracked Pi owner and run-bound settled-idle acknowledgement, reserves dispatch, deduplicates request IDs, disables prompt expansion, and fails closed on ambiguous transport or recovered artifact-only custody. A future question channel would additionally need explicit question/answer correlation, persistent blocked state, cancellation/late-answer rules, authority checks and safe handling of concurrent manual input/reload/restart. Until those semantics have dedicated tests, use `caller_ping` for help and `subagent_resume` under its existing guards; use keepOpen for already-supported settled-turn collaboration. No speculative question/progress tool is registered by this policy change.

### Chosen keep-open semantics

`keepOpen` is defined as **tracked ongoing collaboration**, not a one-time
terminal handoff. By default, each completed turn publishes a distinct result to
its immediate parent while preserving session ownership and the watcher. Pi's
opt-in [`completion-mode: explicit`](#completion-mode) changes when normal stops
publish. Manual pane input and `subagent_resume` follow-ups both retain tracking.
Once `close:false` opts the
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

Explicit `subagent_done` and `caller_ping` stage intent, not immediate completion:
publication and shutdown wait for Pi's `agent_settled`, including sibling tools and
native follow-ups. Ping wins a mixed ping/done batch. Completion-batch failures
remain visible, but an earlier tool error successfully recovered before finishing
does not poison the result. Session path and original header must still match;
`/new`, unrelated `/resume` and `/fork` detach supervision rather than closing the
new session, while `/reload` preserves the same supervised identity.

A child publication failure retains the exact settled payload and retries three
times (100/500/1000 ms), then visibly pauses. Use `/subagent_retry_completion` in
the supervised child for an explicit retry without a model turn. Pending data
survives in-process reload, not process death while storage is unavailable.
Parent artifact-read/supervision failures pause without closing a working child;
`/subagents-reconcile` explicitly retries bounded artifact reconciliation/imports,
never launches children or replays uncertain dispatch. Recovery diagnostics show
remaining errors; one recovered run's I/O failure does not disable healthy runs.

**Interaction flow for an ordinary worker:**
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

### Opt in: one coordinator per feature (Pi only)

Ask the main Pi session explicitly, for example:

> Use one feature coordinator per feature in the current plan. First add CSV
> export; then add a download button that uses the export. Verify and accept
> the export before starting the button. Keep detailed worker reports out of
> the main session.

The main session records a task per feature in its existing plan and runs one
feature at a time in dependency order. For each ready task it starts an attempt
and launches a fresh `feature-coordinator` with `planTask` and an explicit
`cwd`, without `fork: true`. The coordinator delegates implementation and tests
to a worker, and adds scouting or review when needed. Its children report to it,
not the main session. The coordinator does not edit code or accept tasks; these
workflow rules are not a sandbox.

The coordinator returns one concise, structured proposal with criterion checks
and durable references. The main session verifies the references, records
criterion evidence, and explicitly accepts the task before starting a dependent
feature. It passes only relevant dependency decisions and references forward,
not prior conversations or full reports. Partial, blocked, unstructured or
uncertain results do not unlock dependent work. After a restart, inspect the plan
and recovery records rather than rerunning uncertain work. See the
[bundled plan instructions](../pi-extension/subagents/plan-skill.md#opt-in-execution-one-coordinator-per-feature-pi-only)
and [assignment/result contracts](../CONTRACTS.md). This requires no new command
and does not change ordinary `/plan` or `/iterate`.

---

## The `/iterate` Workflow

For quick, focused work without polluting the main session's context.

```
/iterate Fix the off-by-one error in the pagination logic
```

This always forks the current session into a subagent with full conversation context. It does not inherit an agent default `session-mode`. Make the fix, verify it, and exit to return. The main session gets a summary of what was done.

---

## Example project `AGENTS.md`

Copy this block into your project's `AGENTS.md` and adapt it to your team's
review and testing rules. These are instructions for the main Pi session, not
extension settings or permission to bypass project trust.

```markdown
## Working with Pi subagents

- Handle small, low-risk changes directly. Delegate when it saves time, keeps
  noisy work out of the main session, or adds an independent check.
- Choose by role: `scout` for a specific unknown, `planner` for design choices,
  `worker` for implementation and tests, and `reviewer` for independent review.
  Give each agent a goal, file scope, constraints, and acceptance criteria.
  Pass only relevant context. Run independent work in parallel, but do not
  assign concurrent edits to the same files in a shared checkout.
- For multi-step work, use `plan_read` and `plan_update` to track tasks,
  dependencies, and acceptance criteria. Start an attempt before delegation
  and bind the run with `planTask`. The main session verifies the changes and
  evidence against the version under review, records evidence for each criterion,
  and explicitly accepts the task. A completion report is not acceptance.
- When the user requests one coordinator per feature, start a fresh
  `feature-coordinator` for each ready feature with `planTask` and an explicit
  `cwd`, without `fork: true`. Let it delegate and verify the work; it returns
  a short proposal with evidence references. Run features one at a time by
  default. Start dependent work only after accepting its prerequisites, and
  pass forward interface decisions and evidence references, not full reports.
- Wait for automatic result delivery; do not poll. Surface blockers promptly.
  For long tasks, use `context_checkpoint` for concise decisions, next steps,
  and verification references, never credentials or raw logs. After restart,
  read the plan and recovery records before acting; saved records do not prove
  liveness. Do not relaunch work whose outcome is uncertain.
- Preserve results before using `subagent_close` on owned idle sessions that
  have no concrete follow-up. Respect its safety checks. Do not commit or push
  without explicit user authorization.
```

See [durable task plans](#durable-task-plans-pi) and the
[opt-in coordinator workflow](#opt-in-one-coordinator-per-feature-pi-only).

---

## Custom Agents

Place a `.md` file in an explicitly authorized `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Lookup uses the frontmatter `name`; matching the filename is recommended but not required:

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
| `auto-exit`   | boolean | Controls default closure on completion. Ordinary autonomous agents (scout, worker) need no `subagent_done` call after a normal final response; Pi's explicit completion mode is an exception. Claude uses its Stop hook for autonomous runs. Also determines the default value of `interactive` (see below). |
| `completion-mode` | string | Pi-only opt-in `explicit`: ordinary stops wait silently only while supervised delegation can wake the agent; otherwise an ordinary stop without explicit intent reports incomplete work. Omit for existing behavior. |
| `interactive` | boolean | derived        | Compatibility metadata, defaulting to the inverse of `auto-exit`. Explicit values take precedence. Observed stall/recovery never wakes the parent, regardless of this flag. |
| `cwd`         | string  | Default working directory (absolute or relative to project root)                                                                                                                                                                                                            |
| `disable-model-invocation` | boolean | Hide this agent from discovery surfaces like `subagents_list`. The agent still remains directly invokable by explicit name via `subagent({ agent: "name", ... })`. |

---

Discovery still resolves precedence before visibility filtering. If a project-local hidden agent has the same name as a visible global or bundled agent, the hidden project agent wins and the lower-precedence agent does not appear in `subagents_list`.

### Parent context protection

Three protections share a single policy: early compaction, durable working-state
checkpoints, and bounded child reports. They are enabled by default on ordinary
package load; no changes to your Pi settings files are made automatically.

Configure `config.json` (or copy the defaults from `config.json.example`):

```json
{
  "contextProtection": {
    "enabled": true,
    "reserveTokens": 50000,
    "reservePercent": 20,
    "keepRecentTokens": 20000,
    "maxReportBytes": 12000,
    "providerPayloadWarningBytes": {}
  }
}
```

**Early compaction.** The parent targets a reserve of the larger of 50,000 tokens
and 20% of the effective context window reported by Pi's usage API, capped at 40%
for small models. This honors the latest physical response's limits for virtual
model selections, even when their declared limits differ or are unknown. For example, the
128k-window threshold is 78k; a 1M-window threshold is 800k. The recent tail is
capped at half the remaining usable window; a smaller native/per-model retention
setting is honored between turns. `enabled:false` disables proactive compaction;
Pi's `compaction.enabled:false` is also respected. Checkpoints and report limits
remain available independently. `/context-guard` shows budgets and the last error;
`/context-guard retry` clears the failed-attempt cooldown without starting a turn.

Before an idle user prompt, the guard can use native compaction. During a tool
run it instead awaits a summary at Pi's actionable `turn_end` boundary and returns
a native compaction draft: it never calls the aborting manual compaction API from
a running tool turn, and never schedules an extra agent turn. The latest
assistant/tool-result batch stays together. Edited/omitted context is respected;
truncated (`length`) responses remain Pi's recovery responsibility. Summaries must
meaningfully shrink the prefix (at least 1,024 tokens or 2% of the window); failed
or unusable summaries retain history and enter a three-completed-turn cooldown.
Cancelled idle compaction also cancels submission of that pending prompt.

Between-turn guard summaries use the active configured selection through public
`modelRegistry.streamSimple(...).result()`. Virtual selections invoke their router
with reason `direct`; Pi caps the positive requested budget to the routed physical
model's output limit. The guard cap is 8,192 tokens (or the smaller known
model/effective-window budget); unknown virtual output limits are not zero-token
requests. A physical model merely named `auto` is not treated as virtual. They are additional
billable calls. These boundary drafts do **not** emit Pi's native
`session_before_compact`/`session_compact` notifications or use other extensions'
custom native summarizers; native/manual/overflow compaction still does. Disable
proactive compaction if another extension must own all summarization, and configure
Pi's native `compaction.reserveTokens` instead.

**Provider payload bytes (advisory).** `/context-bytes` reports numeric UTF-8 JSON
sizes observed at `before_provider_request`, without logging request contents.
Optional `providerPayloadWarningBytes` thresholds are keyed by provider or exact
`provider/model` (model wins); for example `{ "openai-codex": 900000 }` is a
user-chosen warning threshold, **not** a documented backend limit. Values must be
safe integers of at least 1,024 bytes. The empty default assumes no universal
limit. `enabled:false` disables warnings, not numeric observations.

These are payload bytes at this hook position: later extensions may change the
body, routed models may differ from the selected model, and Codex chooses
full/delta WebSocket frames or compressed HTTP bodies afterward. Providers that
omit `onPayload` (including installed Kiro 0.12.3) are unobserved. Hook exceptions
are swallowed by Pi; `ctx.abort()` is not a guaranteed pre-send gate on a reused
socket. Therefore this feature neither blocks sending nor automatically compacts
on HTTP 400. Final-wire enforcement requires a host/provider API change. The
incident's suspected 1 MiB boundary is not hardcoded as a universal limit.

**Durable working state.** The parent should call `context_checkpoint` at milestones:

```json
{
  "action": "save",
  "goal": "Finish the migration without changing public behavior",
  "decisions": ["Keep the existing database schema"],
  "nextSteps": ["Run migration regression tests"],
  "verification": ["Unit tests passed; integration tests not run"],
  "refs": ["docs/migration-report.md"]
}
```

`context_checkpoint({"action":"read"})` reads the selected branch. Save returns a
short status/entry/durability receipt; full UI details remain available. Saving replaces
all five fields; each list accepts up to 12 items. Explicit state is bounded to
6,000 UTF-8 bytes. Before native or proactive compaction, the extension captures a
fresh bounded plan summary/pointer alongside those notes. Unchanged snapshots are
not appended repeatedly. The existing plan remains authoritative for task state,
revision, evidence and acceptance; checkpoints never grant authority or imply
process liveness. Automation snapshots already saved notes and the plan—it cannot
recover decisions the agent never recorded.

Checkpoint state lives as native custom session entries, not repository files.
Bounded model-visible publications carry working notes at existing agent/turn
boundaries, deduplicated against actual visible context and successful save receipts.
Restoration omits historical plan summaries/pointers beside the current plan.
A narrow read-only post-compaction fallback restores notes (up to 12,000 UTF-8
bytes) until the next durable boundary, independently of conversational summaries.
Pi 1.3/1.5 lack an actionable post-compaction/pre-request publication hook, so
full incremental-continuation stability for that fallback remains host-blocked.
Only the active branch is read. Fork-inherited notes are read-only until an
explicit save creates local notes; children cannot save parent checkpoints.
Ephemeral/setup-only sessions cannot promise durable checkpoints. An append failure
cancels compaction and suppresses uncertain checkpoint content across `/reload`;
recovery requires reopening in a fresh Pi process. Do not save secrets, credentials,
raw conversations or full logs; use artifact references.

**Bounded child reports.** Every new result, help request and error is bounded to
`maxReportBytes` UTF-8 bytes **before** it enters the durable outbox. Oversized
reports become a head/tail preview plus a full artifact path, with the notice
included in the limit. Full content and details are preserved in immutable,
content-addressed JSON files under the run's artifact/runtime directory in
`subagent-reports/`. Read a referenced artifact with a bounded `read` if needed.
Reports that fit are unchanged. Structured proposals and full UI details remain
intact; transport retry, event identity and parent review/acceptance are unchanged.
If archive storage fails, a bounded notice says so and points to the child session
instead of claiming the report was saved. Existing outbox/history records are not
rewritten. `maxReportBytes` accepts 1,024–50,000; other token budgets are non-negative
safe integers and `reservePercent` accepts 5–40.

These are safety margins, not a guarantee against a giant incoming user/tool
message, many simultaneous reports, inaccurate token estimates, provider outages,
or an oversized system prompt/indivisible tool batch. Native Pi overflow recovery
and `/compact` remain available. Checkpoints and report artifacts are local
same-user storage, not a secrets vault or an OS security boundary.

### `session-mode`

Choose how a subagent session starts:

- `standalone` — default fresh session with no lineage link to the caller
- `lineage-only` — fresh blank child session with `parentSession` linkage, but no copied turns from the caller
- `fork` — linked child session seeded with the caller's prior conversation context

`lineage-only` is useful when you want session discovery and fork lineage UX to show the relationship later, but you do **not** want the child to inherit the parent's turns.

`fork: true` on the tool call always forces the `fork` mode for that specific spawn. `/iterate` uses this explicit override on purpose.

#### Long sessions and handoffs

Fork inherits conversation context; it is **not** a context reset. For bounded tasks,
prefer `standalone` or `lineage-only` with a concise assignment and relevant artifact
paths. Keep full reports in files and return short findings, checks and blockers
rather than repeatedly pasting logs or loading large images into the parent.

Save handoff notes at milestones, before the context window is nearly full. Use
Pi's native `/compact [instructions]` when needed; asking for a final summary in
chat is another model request, not a guaranteed recovery mechanism. This extension
now adds [parent context protection](#parent-context-protection) before Pi's native
overflow recovery. Pi still owns native automatic/manual compaction. In versions
supporting per-model compaction settings, an optional project `.pi/settings.json`
override can also reserve more headroom (merge into existing settings; do not replace them):

```json
{
  "compaction": {
    "enabled": true,
    "modelOverrides": {
      "openai-codex/gpt-6.1-sol": { "reserveTokens": 65536 }
    }
  }
}
```

Choose the exact provider/model key and a reserve below its actual context window;
Pi triggers above `contextWindow - reserveTokens`. This reduces context pressure,
but cannot prevent provider failures or user cancellation. An empty `aborted`
response does not identify the cancellation source or prove context overflow.
Check the session and Pi diagnostics before retrying: do not automatically replay
subagent results or relaunch work whose model consumption is unknown.

Pi supports all three modes by loading the selected session file. Every Pi task uses one controlled file attachment, including the `direct`/fork prompt shape: raw task text is never a CLI flag or recursively expanded `@file`. Role, skills and task share the initial input; closed resume does not replay the initial role/skills. Claude, Codex, OpenCode, Grok, and generic command templates support only `standalone`: they do not consume seeded Pi JSONL. Requesting `lineage-only` or `fork` with those harnesses fails before creating a pane or session artifacts; it never silently drops the requested transfer.

`resumeSessionId` is a separate native-harness operation, supported only by Claude (`--resume`) and OpenCode (`--session`). It cannot be combined with Pi session transfer. Other harnesses reject it instead of ignoring it; use `subagent_resume` for Pi session-file resume. Turn-only interrupts and structured activity snapshots remain Pi-only.

```yaml
---
name: planner
session-mode: lineage-only
---
```

### `auto-exit`

With the default completion behavior, `true` closes the session automatically on a normal final response; no explicit `subagent_done` call is needed. Setting `auto-exit: false` alone does not suppress completion notifications on Pi.

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

### `completion-mode`

Omit this field for the existing behavior. The bundled `feature-coordinator`
opts in to Pi-only `completion-mode: explicit` alongside `auto-exit: false`:

```yaml
---
name: feature-coordinator
session-mode: lineage-only
completion-mode: explicit
auto-exit: false
---
```

An ordinary stop while supervised delegation can wake the coordinator leaves it
waiting without reporting a result to its parent. Without a wake source or
explicit completion intent, an ordinary stop reports incomplete work. Finish
with `subagent_done({ result, close: true })` to publish the feature proposal
at Pi's settled turn boundary. Provider and supervision failures and explicit
help requests are not silenced. A provider output-token limit reports incomplete
work and leaves the coordinator open. While a worker can still report, the
coordinator cannot be closed with `subagent_close`: a ping (or partial/blocked
proposal) reports without closing, and a premature success is not published.
After the last worker reports, verify the results and call `subagent_done` again.
Reload rechecks a silent wait; it does not start another worker.
Pi resume preserves the saved setting; workers
spawned by the coordinator do not inherit it. This is independent of the global
`maxReportBytes` bound.

The coordinator owns its implementation, independent review, and repair loop.
Worker completions and follow-ups wake their immediate coordinator, not the root.
The coordinator can audit and continue its worker directly, whether it remains
open or has safely closed. Reserve `caller_ping` for blockers or decisions the
coordinator cannot resolve; otherwise send one concise final evidence summary.
An already-launched coordinator keeps its saved tool allowlist on resume; start
a new coordinator with the updated profile if that allowlist omitted lifecycle
tools.

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

## Project source trust

Project definitions can select executable CLI templates, tools and role-specific working
folders. Pi's standard trust check does not prompt for an agents-only `.pi/agents/`
checkout. Therefore this extension requires a separate, user-owned allowlist at
`<parent-agentDir>/subagent-trust.json` (default `~/.pi/agent/subagent-trust.json`):

```json
{
  "projectAgentDirectories": ["E:/trusted-project/.pi/agents"],
  "agentDirectories": ["E:/trusted-project/.pi/agent"]
}
```

Approve only reviewed sources. Entries must be absolute paths and match the exact
canonical source directory; approving a parent folder does not approve descendants.
The first list enables project roles/overrides. The second separately permits that
checkout's `.pi/agent` as the child's **user-level configuration**, including startup
extensions. Both lists default to empty. To approve the current checkout's existing
`.pi/agents` directory interactively, run `/subagents-approve`; it adds only
that canonical directory to `projectAgentDirectories`. It does not approve the
checkout's `.pi/agent` or override Pi's regular project-trust decision. Normal
project `.pi/extensions`, skills and settings remain subject to Pi's own project
trust.

A host trust denial, missing host trust API, or saved denial for a target cwd blocks
these approvals. Children otherwise inherit the parent's agentDir; merely finding a
local `.pi/agent` no longer promotes it. Discovery uses the current authorized cwd,
and dispatch checks source identity/content again after asynchronous preparation.
Resume rechecks the saved agentDir and recorded definition source against current
approval; revocation is not bypassed by a saved profile. These controls are not a
sandbox: Bash and explicitly trusted custom commands retain normal OS permissions.

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
| feature-coordinator | `true` | Delegates work and checks for just its assigned feature |
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

- Node.js 22.19.0 or newer (the version Pi itself requires)
- [pi](https://github.com/earendil-works/pi) 1.5.2 or a compatible 1.5.x patch. The audit repairs were also verified offline on 1.3.0, but that host pins vulnerable dependencies and is no longer the recommended/supported install. Updating this repository's local dependencies does not update your global Pi executable.
- [herdr](https://herdr.dev) — the required terminal workspace

```bash
herdr
pi
```

Other multiplexers and terminal backends are not supported.

---

## Development

Run unit tests, lint and the type check locally (CI runs the same on Ubuntu and Windows for every pull request):

```bash
npm test
npm run lint
npm run typecheck
```

Run integration tests **inside the terminal backend being verified**:

```bash
npm run test:integration:transport       # real terminals, no model requests
PI_TEST_MODEL="openai-codex/gpt-6.1-sol" npm run test:integration:plugin
PI_TEST_MODEL="openai-codex/gpt-6.1-sol" npm run test:integration
```

Use an exact model authenticated on your host; the example is not a credential guarantee. Pi journeys make real, potentially billable requests. The runner detects HC versus legacy herdr, checks prerequisites, and fails rather than reporting an all-skipped success outside either environment. `--backend=hc` or `--backend=legacy` explicitly selects one; HC never substitutes for legacy compatibility.

`test:integration:plugin` covers discovery and literal `/subagent`, forked context, invalid-agent rejection/recovery, and durable plan/checkpoint reload on HC. `test:integration:pi` adds the existing lifecycle/recovery journeys; the default runs transport plus both Pi groups. Legacy uses its existing transport/lifecycle/Claude-adapter fixtures. Results are backend-specific, and known failing journeys remain enabled. `PI_TEST_MODEL` pins parents and seeded children. `PI_TEST_TIMEOUT` controls legacy per-test waits (default `180000` ms); HC uses bounded per-step waits and a ten-minute journey deadline.

See [the integration test matrix](https://github.com/gszczutkowski/pi-herdr-subagents/blob/main/test/integration/README.md) for coverage, evidence, filtering, and limitations. Inspect both `assertions.json` and `cleanup.json` in each HC journey's `.git/verification/` directory; skips or terminal creation alone are not end-to-end proof.
