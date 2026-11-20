# pi-herdr-subagents

Run async subagents for [Pi](https://github.com/earendil-works/pi) in dedicated [herdr](https://herdr.dev) terminals. Your parent session keeps working while subagents run in the background; results come back automatically when a subagent finishes.

## Requirements

- Node.js **22.19.0** or newer
- Pi **1.5.2** or a compatible 1.5.x patch (see the package's `peerDependencies`)
- Legacy herdr or herdr-core (`hc`). The `hc` adapter also requires Bash; Git for Windows provides it. Other terminal backends are not supported.

## Quick start

1. Install the extension:

   ```bash
   pi install npm:pi-herdr-subagents
   ```

2. Open a terminal in herdr (or herdr-core) and start `pi` in that terminal. If Pi was already running, use `/reload` to load the extension.
3. In Pi, launch a bundled scout:

   ```text
   /subagent scout Map this repository and summarize the main entry points.
   ```

The scout opens in its own terminal without stealing focus. The subagents widget shows its status, and the result returns to the parent session. You can also ask Pi to start several independent subagents in parallel, or use `/plan` for a planning workflow. Bundled roles include `scout`, `planner`, `worker`, `reviewer`, and `visual-tester`.

## Documentation

- [Full reference](https://github.com/gszczutkowski/pi-herdr-subagents/blob/main/docs/REFERENCE.md) — terminal setup, tools, configuration, custom agents, durable plans, and recovery
- [Assignment and result contracts](https://github.com/gszczutkowski/pi-herdr-subagents/blob/main/CONTRACTS.md) — structured results and parent review
- [Worked example (Polish)](https://github.com/gszczutkowski/pi-herdr-subagents/blob/main/docs/SUBAGENT-WORKFLOW-PL.md)
- [Known limitations and backlog](https://github.com/gszczutkowski/pi-herdr-subagents/blob/main/BACKLOG.md) · [Historical handoffs](https://github.com/gszczutkowski/pi-herdr-subagents/tree/main/docs/history)
- [Development and verification](https://github.com/gszczutkowski/pi-herdr-subagents/blob/main/docs/REFERENCE.md#development) · [Release process](https://github.com/gszczutkowski/pi-herdr-subagents/blob/main/RELEASING.md)

The npm archive also includes `docs/REFERENCE.md` and `CONTRACTS.md` for offline reading.

## Acknowledgements

The subagent status supervision and turn-only interruption features were inspired by [RepoPrompt](https://repoprompt.com/).

## License

MIT
