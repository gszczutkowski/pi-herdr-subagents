# Assignment and result contracts

This is a format reference, not a second execution checklist. Current repair status is tracked in `BACKLOG.md`; `.pi/plans/2026-11-14-subagent-orchestration/plan.md` records the earlier orchestration milestone.

- Optional bounded assignment contract. `subagent.assignmentContract` supplies objective, scope, criteria (`criterionId`, `text`), dependencies, inputs, files, decisions and changeConstraints. With `planTask`, objective/scope/criteria/dependencies/inputs are derived from the existing task (artifact refs are inputs); supplied values must agree exactly. Supplemental constraints are caller-owned. Limits: 100 items per list and 8192 characters per nonempty field. Metadata is saved in the launch profile, runtime manifest profile and assignment card. The contract is also included once in the actual model task; the card is display-only. Unbound plain tasks are unchanged.
- Optional structured per-turn result. `subagent_done({ result, close: false })` publishes a supervised turn without closing. Result fields: status (`complete`, `partial`, `blocked`), summary, artifact refs, checks (`criterionIds`, `ref`, `outcome`: `passed`/`failed`/`not_run`), unmetCriterionIds and risks. Strict fields and the same bounded lists/text apply. Claims survive immutable completion events, outbox, parent presentation and artifact-only recovery; the assistant's final text remains a separate compatibility summary. A result is a proposal, never an acceptance decision.
- Parent-validated criterion evidence and explicit acceptance. Bound delivery imports only a canonical result reference through `PlanPersistence`; it never imports worker checks as accepted evidence. Unknown criterion references and incomplete `complete` claims produce review diagnostics without dropping results. Parent inspects each artifact/check, then uses existing `plan_update` commands: `evidence` with the exact criterionId, inspected ref and canonical resultEventId, followed by a separate `accept` with ALL criterion IDs mapped to their matching evidence IDs and a parent reason. Neither `testsPassed`, `complete`, evidence import, nor process exit accepts work. Invalid criterion/result/artifact refs reject without changing the saved proposal.
- Legacy and malformed optional-result compatibility. Old sidecars, foreign-harness/plain-text output and omitted results retain normal delivery, labeled unstructured parent review in the parent message. `subagent_done` prepares malformed optional result arguments as plain completion before strict tool validation; sidecar/direct-boundary malformed output retains a diagnostic. Unknown top-level tool fields are still rejected. No fallback can certify or accept work. Contracts/results are capped at 40,000 JSON characters overall in addition to per-field limits. Immutable event IDs, cursor/outbox commit ordering, original branch authority, process identity, leases and terminal-control guards are unchanged.

## Instruction, summary and context boundaries

Explicit spawn `systemPrompt` supplements the named agent body, in that order;
it never silently replaces it. Pi `system-prompt: append/replace` still controls
placement against Pi's own prompt. Without that setting, role instructions travel
with the task in standalone/lineage-only/fork modes. Live continuation requires a
nonempty raw message before contract metadata; closed-session resume remains optional.

Compatibility summaries come only from new entries of the current supervised task
on the active native branch. A textless task reports that explicitly rather than
falling back to a previous task. Structured result proposals remain independent.

Plan mutations/checkpoint saves return compact receipts while retaining full UI
`details`; explicit reads provide missing information. Native publications use
existing agent/turn boundaries and visible receipt chains. Pending imports precede
publication. None of these changes grants acceptance, process liveness or terminal
custody. A narrow post-compaction read-only fallback preserves exact state; full
delta stability on that path is a documented host dependency, not a solved guarantee.

## Plan read pagination

`plan_read` keeps the existing small overview/task shape; every successful text
response is valid JSON within 40,000 UTF-8 bytes and 2,000 lines. Large default
reads return navigation instead of a clipped document. Collection `section`
reads accept zero-based `offset` and `limit` (default 50, max 100): `tasks`
without `taskId`; `definition`, `criteria`, `dependencies`, `artifacts`,
`attempts`, `runs`, `results`, `evidence`, `decisions`, `statusHistory` with it.
Attempts pages expose metadata/counts; results/runs carry their `attemptId`.

Follow `next` as returned: its `planId` and `expectedRevision` pin the snapshot.
A changed identity/revision rejects the cursor; restart instead of mixing pages.
JSON cursors additionally pin `documentHash` (SHA-256 of the entire serialized
view). Restore/reconcile/access diagnostics can change without a plan revision;
that change rejects the old document cursor as well. Nonzero JSON offsets require
this returned cursor, not a manually incremented offset without the hash.
A single oversized item is not skipped: `oversizedItem` and `jsonRead` identify
recovery through `section: "json"`. Join all `jsonText` fragments and parse the
resulting complete view, including authority/recovery diagnostics. JSON offsets
and limits are UTF-16 string positions (default 4,096, max 8,192), not bytes or
lines. Without `taskId` that document includes every full task.

Pages are explicitly partial, retain access/error/uncertainty indicators and
never grant mutation authority or claim full plan-context publication. Their
hidden tool details contain only the page. Small reads retain their existing
snapshot/details/receipt semantics. Read cursors do not certify runtime liveness.

## Interrupt control boundary

`subagent_interrupt` requests the public Pi abort API through a child-issued
`interrupt-v1` active capability bound to run/session/header/process identity.
It never sends terminal keys, Ctrl+C or process signals. `interrupt_requested`
acknowledges the child API call; `settlement: aborted` requires its separately
correlated aborted-settlement record. Otherwise settlement is `unconfirmed`;
`pending` is uncertainty, not permission to retry or use a fallback. Missing,
expired/idle or legacy support rejects without dispatch. Claims never replay after
reload/API/storage ambiguity. The process and supervision remain alive, and resume
requires its own fresh settled-idle capability. A stale active parent observation
can be overridden only by fresh `interrupted-idle` child proof plus confirmed idle
pane, never by ordinary idle evidence or an actually busy child. Final settlement
also clears trailing active activity snapshots. Same-user filesystem trust applies.

## Verification boundaries

Current automated evidence: `test/M4-M5-M6-VERIFICATION.md` (747/747 integrated
tests, including independent review and the document-cursor follow-up fix).
Historical live evidence: `test/integration/HC-WORKFLOW-VERIFICATION.md`
(seven named authenticated HC TUI journeys; not rerun for these three repairs).
Manual HC Escape and authenticated same-batch stress paths are not accepted.
`test/REPAIR-VERIFICATION.md` and the boundary below are historical evidence.

Automated native SessionManager/registered-tool tests cover bound spawn/resume, model-visible criteria, structured turn artifacts, keep-open, outbox restart, parent evidence commands, invalid refs, late results, wrong-branch deferral and plain/malformed compatibility. Terminal transport is mocked: no live herdr or provider session was run. Evidence refs are parent-inspected references, not automatic assertions that a file/test is truthful.
