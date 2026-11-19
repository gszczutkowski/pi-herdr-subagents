import { resolve } from "node:path";
import { bashPath } from "../../pi-extension/subagents/hc.ts";
import { shellQuote } from "../../pi-extension/subagents/terminal.ts";

export const localPiCli = resolve(import.meta.dirname, "../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

/** Run the same Node and Pi binaries used by integration preflight, not pane PATH. */
export function localPiShellCommand(): string {
  return [process.execPath, localPiCli].map(path => shellQuote(bashPath(path))).join(" ");
}
