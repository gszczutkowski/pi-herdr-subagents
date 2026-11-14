# Interrupt a child turn

A user stops a Pi child's current turn while leaving its pane, process, and session available for further interaction.

## Sub-features

- `interrupt-tool`: target a running child by exact ID or unique name.
- `interrupt-survival`: child becomes open/interrupted rather than closing. This holds for a child that does not auto-exit.
- `interrupt-no-completion`: interruption alone does not produce a fake completion result. This holds until the child's own turn settles; an auto-exit child that settles with `stopReason: error` still reports a failure result.

## How to get to it (user POV)

- Ask the parent to call `subagent_interrupt` with the child's ID or exact name.
- Open the child's herdr tab and press Escape directly in Pi.

## Driving it with control-subagents

Preconditions: healthy baseline; Pi-backed child actively executing a long task. The seed has no running child, so launch one first.

- **Start long work.** Run `"$CONTROL" send "$EVIDENCE" 'Call subagent with name InterruptWorker, agent verify-worker, interactive true, task Run bash: echo STARTED > interrupt-start.txt; sleep 90; echo FINISHED > interrupt-finish.txt. End your turn after spawning.'`. Wait until `interrupt-start.txt` exists in scratch and the child pane/session shows a live bash call. Capture before interruption. If the task has already finished, fail this attempt and restart with a fresh run.
- **Tool interrupt.** Run `"$CONTROL" send "$EVIDENCE" 'Call subagent_interrupt with name InterruptWorker. Do not close its pane or send Ctrl+C.'`. Require a successful interrupt acknowledgment in the tool result. Capture using `"$CONTROL" capture "$EVIDENCE"` and read the exact child pane with `herdr pane read "$CHILD" --source visible --lines 200`. Require Pi to be idle/open, `herdr pane get "$CHILD"` to succeed, no finished marker, and no `subagent_result` caused solely by interruption.
- **Prove surviving interaction.** Use `herdr pane run "$CHILD" 'Reply exactly INTERRUPT_SURVIVED and do not call tools.'`. Capture the child response and pane metadata into evidence. A surviving shell alone is insufficient. This probe ends the child's turn normally, so an auto-exit child then writes its sidecar, completes, and closes its pane. Record that as the expected result of the probe, not as a false completion. Assert no-false-completion before this step.
- **Direct Escape variant (fresh run).** Repeat long work, then `herdr pane send-keys "$CHILD" Escape`. Apply the same survival, marker, and no-false-completion assertions. Capture both actions and both child states.

## Gotchas

- A shell sleep interrupted with Ctrl+C does not prove `subagent_interrupt`. Do not replace the real Pi task with that stand-in.
- The helper's generic `send` does not wait; capture only after checking the real active-task precondition.
- Escape interrupts the Pi turn; it does not promise to roll back already completed file writes or external work. Record observed side effects, including the STARTED marker.
- This tool supports Pi-backed children, not Claude or arbitrary CLI children. Name ambiguity is an error; use the returned exact child ID if necessary.
- `interactive: true` on a named agent does not change its exit behavior; that comes from the agent's `auto-exit` frontmatter. It suppresses stall and recovery steers only.
- After an interrupt the extension's own state is `interrupted`, not idle, and it outranks herdr's coarse status. A successful tool acknowledgment does not prove a turn was running; only the child pane's state does.
- **Historical legacy observation, not a current HC blocker.** An earlier auto-exit `verify-worker` interrupted inside a tool settled with `stopReason: error`, wrote an error sidecar, closed, and delivered `The operation was aborted.` That run did not prove interruption survival. Current HC acceptance uses the non-auto-exit `verify-open` role and separately requires aborted settlement, a surviving child and no abort-only completion. It does not retest the legacy auto-exit variant.
- For HC use the isolated `interrupt live continuation` test in `test/integration/hc-tui.test.ts`: the `verify-open` role disables automatic exit, a real bash gate proves active work, and aborted settlement plus surviving process/pane and no result are required before `subagent_resume`. Resume must retain the same run and process. The earlier HC tagged-private-command transport failure was corrected by production `artifact-v1` continuation; see `test/integration/HC-CONTINUATION-VERIFICATION.md`. Pending dispatch alone is still not proof: require the child's accepted acknowledgement and completed follow-up.
- Completion delivery is not suppressed for interactive children. Ordinary progress is panel-only; actual results and help requests still wake the parent.
