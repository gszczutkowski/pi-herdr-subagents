# Core HC Pi TUI workflow verification — 2026-11-16

## Precommit follow-up and local commits

After explicit user authorization to commit the entire branch, fresh verification
found and repaired one additional interrupted-resume race. The initial precommit
core command passed 6/7: native cancellation drained a trailing `turn_start` after
`agent_end`, leaving an active activity snapshot newer than the parent's interrupt
marker. The child had genuinely aborted, HC reported idle and a fresh
`interrupted-idle` token existed, but the parent's active-label prefilter refused
resume. This failed attempt is retained, not reclassified as passing.

Final idle `agent_settled` now overwrites trailing active activity before any done
publication. Continuation can override an active **parent observation** only with
a fresh child `interrupted-idle` token plus idle-pane validation; ordinary idle,
busy/expired proofs and child-side pending work still reject. Red regressions were
retained; independent final review approved the fix after 34 focused tests.

Fresh corrected precommit results:

- `npm test`: **734/734**, zero failures/skips/cancellations, 183,939.7309 ms.
- The same selected core command below: **7/7**, zero failures/skips,
  434,124.6171 ms.
- Lint and whitespace checks pass; unchanged dependency lock audits at **0 vulnerabilities**.
- Parent inspected all seven new assertion/cleanup records and matched behavioral
  source hashes; all **17** new owned terminal entries independently queried missing,
  with no unresolved custody.
- Private evidence: `.git/verification/2026-11-16-precommit/` contains
  `tests-race-fixed.log`, `live-core-race-fixed.log`, `audit.json`, `summary.json`
  and retained failed/red attempts.
- Final live UUIDs: close `3d39031f-8803-4698-b0ab-6298d6f2612b`, parallel/reload
  `79517a5b-f4bf-461e-abdd-b84ce4449f0f`, closed resume
  `bec5ab3c-8fcf-4703-9173-07d22eb35353`, keep-open
  `b401204c-455f-4fe8-b205-b3397661f4df`, interrupt/resume
  `c75f4653-71df-4b8d-b1ff-5a3cf316f6cd`, idle new
  `687dabfe-7b6f-45a2-8958-2ac9c772d552`, parent recovery
  `22410ae6-e2ac-4c2c-a667-2bbbfac67df5`.

Implementation/tests/config/dependency changes were committed locally as
`8f8d53c`; the accompanying documentation and skills are committed separately.
No push or global configuration/installation update. All manual-key, extra
same-batch and platform/provider limitations below remain unchanged.

## Original repair result and scope

**Final serial core command: 7 passed, 0 failed, 0 skipped.**
**Final `npm test`: 733 passed, 0 failed/skipped/cancelled; lint passes.**

This verifies the seven named workflows below on the current working-tree
extension. It is **not** acceptance of every integration entry point or all
context/provider optimization plans.

Environment: Windows, Node 24.21.0, local Pi **1.5.2**, HC **0.1.21**,
authenticated `openai-codex/gpt-6.1-sol`. Repository root, branch
`fix/subagent-repair-sequence`, base HEAD `d226f33`. The existing dirty tree was
preserved; at this initial verification milestone no commit/reset, global Pi
upgrade, or global trust change was made. The later authorized local commits are
recorded above.
This was not a MAIN-branch release run. The global Pi executable remains 1.5.0.

Legacy `HERDR_ENV`/`herdr` was absent. The separate HC TUI path explicitly allowed
by the verification skill was used, not the legacy integration suite.

## Defects repaired

1. **Core interruption:** production `hc keys <child> esc` repeatedly timed out
   after 15 seconds, without child aborted settlement. A direct manual-key
   journey independently timed out. HC's public schema describes a quiet-period
   wait for named keys; the exact internal cause was not proven.
2. **Safe replacement:** `interrupt-control.ts` provides a child-issued active
   capability bound to run, canonical session/header, process birth and nonce.
   The child synchronously validates and durably claims before public
   `ctx.abort()`. No terminal keys, Ctrl+C, shutdown or process signal fallback.
   Claims never replay after ambiguity. Settlement/reload/replacement invalidates
   active proofs; both parent awaits revalidate custody/task binding.
3. **Honest acknowledgement:** `interrupt_requested` acknowledges the child API
   request. A distinct correlated aborted-settlement artifact alone permits
   `settlement: aborted`; otherwise it is `unconfirmed`. Unsupported/idle/legacy
   children reject; acknowledgement timeout is pending, not retry permission.
4. **Harness compatibility:** pin the local CLI rather than global 1.5.0; create
   isolated scratch-profile exact role approvals; parse doubly commented Surface
   metadata without weakening shell sanitization. The native test auth bridge
   resolves the original credential store, including normal OAuth refresh, without
   copying credential files/values into scratch/evidence or editing global settings.
5. **Evidence/cleanup:** record production/harness hashes and session headers;
   preserve replacement sessions separately; verify original PID/birth before the
   intentional parent-death test. Missing one launch artifact no longer skips
   later verifiable children. Unresolved custody is reported as `allMissing: false`,
   never permission to close an unverified terminal. Native auth cancellation now
   forwards the actual top-level `input.signal`.

The schema's generic `hc interrupt` can choose Ctrl+C if status is missing. It
was deliberately **not** substituted: a preflight status read cannot make that
choice atomic or Escape-only. Framed input was not invented from incomplete docs.

## Final live evidence

One fresh owned parent per journey; actual Pi TUI startup and exact authenticated
readiness token required. The observer records events, not scripted model replies
or orchestration calls. Side effects are checked against real child bash calls,
correlated results and actual session history.

| Journey | Final run UUID | Assertions |
| --- | --- | --- |
| Owned audit/draft/resume/close | `50e9ed4d-9c30-4db8-ab53-0e1b0212e26f` | Sole PID/birth owner; unsent draft rejects without shutdown/model turn; same-process continuation; verified close after watcher cleanup; original PID absent; identical close receipt. |
| Parallel + reload | `05d840c6-b6e0-4ff9-8a06-bb6386e0d615` | Two overlapping bash gates, distinct runs/sessions, real completion inside instrumented reload gap, both markers/results, no duplicates at settled boundary. |
| Closed resume | `d52a5edc-d3b1-4098-8da6-f20e88407140` | Original terminal gone; new run reuses saved session/history; marker copied by actual resumed bash; successful result. |
| Keep-open follow-up | `4144219a-d192-417c-947f-ab7aa93aaafc` | Two actual turns/results with distinct event IDs; same run/session/process/terminal; original marker retained. |
| Guarded interrupt/resume | `193dde5f-0309-4cfc-9152-1cf6b6522639` | Active bash gate; actual guarded tool acknowledgement; child aborted settlement; no abort-only result; surviving child; production continuation and follow-up marker/result; one startup. |
| Literal idle `/new` | `fd066a9f-1532-4483-8c68-9f2cbd0aea52` | Guarded abort first; literal `/new` after confirmed idle; new session path/header in same PID/terminal; actual replacement bash; no old-run publication or closure. **Not busy `/new` or manual Escape proof.** |
| Parent OS death/recovery | `109abc51-8e65-4ba6-bc4e-efbf67cc7b1f` | Original parent PID/birth revalidated and OS death verified; exact saved parent resumed; new custody generation; child survives without relaunch; artifact-only supervision, rejected recovered controls and two results. |

Final command (a **selected core set**, not all ten registered live journeys):

```bash
PI_TEST_HC_TUI=1 node --test --test-concurrency=1 \
  --test-name-pattern='owned audit draft rejection resume and close|parallel and reload|closed resume|keepOpen followup|^real HC Pi TUI: interrupt live continuation$|literal new after guarded abort|parent OS death and recovery' \
  test/integration/hc-tui.test.ts
```

Private evidence: root `.git/verification/2026-11-16-workflow/` contains
`live-final-core.log`, `final-tests-confirm.log` and `final-summary.json`.
Each final journey has its timestamped sibling evidence directory, including
`environment.json`, actual sessions/events/actions, markers, `assertions.json`
and `cleanup.json`. These artifacts may contain local paths/prompts/model output;
do not upload them.

The parent inspected all seven assertion/cleanup records, matched every recorded
source hash to the final behavioral sources, and independently queried all **17**
final-run owned terminal entries: all missing, no unresolved custody. This proves
removal of those recorded terminals, not an OS-wide sweep or death of arbitrary
detached processes. No user terminal was focused or sent input.

## Automated checks and independent review

- Baseline `npm test`: 712/712; final: **733/733**, zero skips, 187,850.572 ms.
- New default-suite coverage includes 14 abort-control tests and four harness
  tests. Existing interruption fixtures also cover the async custody fences.
- Deterministic native Pi tests exercise unstaged abort and staged `close:true`
  and `close:false`: no extra model turn/shutdown; staged abort remains error +
  keep-open, whereas unstaged abort alone publishes no completion.
- Independent read-only review approved the production protocol after 29 focused
  tests. Separate final harness-fix review passed four tests and approved both
  auth-signal and per-run ownership-cleanup fixes. Reviewers did not rerun live.
- `npm run lint` and scoped/final whitespace checks pass. No full typecheck is
  claimed; the project has no typecheck script/compiler.

One first final-suite attempt failed the synthetic concurrent-resume fixture
under load: its default mocked pane response was **missing** while the newly
asynchronous interrupt allowed the real watcher to run. The focused test passed
alone. The fixture now advertises its intentionally present active terminal from
setup, preserving production custody checks/assertions/timeouts. The failure is
retained in `final-tests.log`; the complete subsequent suite passed 733/733.

## Preserved failures and remaining limits

- Initial authenticated closed-resume failed before dispatch because scratch
  roles lacked the new separate source approval. Production correctly refused.
- Two original tool-interrupt attempts and one manual `hc keys` Escape attempt
  failed with ETIMEDOUT. The guarded **tool** path subsequently passed both a
  focused run (`3d2077d9-524d-4e81-aaa2-b48142d84cb8`) and final core command.
  The **manual HC key path is not repaired or accepted** by that change.
- Authenticated staged done/ping stress attempts generated the completion tool
  alone, not the required same-message bash sibling. Both correctly failed the
  model-input precondition. Offline native batch regressions pass, but there is
  **no authenticated same-batch live proof**. The extra tests remain opt-in and
  fail rather than silently substituting sequential calls.
- An additional no-model raw-terminal diagnostic failed readiness. It supplies
  no key-transport or lifecycle proof and is not counted as a passing test.
- Reload's shutdown interval is deliberately extended 20 seconds by the observer.
  No natural race-frequency, exactly-once consumption, recovered terminal
  adoption, billing/cache/final-wire, alternate-provider/harness, Linux,
  legacy-herdr, physical keyboard/manual Escape, busy `/new`, or full ten-journey
  acceptance claim is made.
- Active old-version children do not acquire the new capability merely because
  source changed. Let existing work finish, then reload/restart on a compatible
  host. The running user/global installation was not upgraded by this task.
