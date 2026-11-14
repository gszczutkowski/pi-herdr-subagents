import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { OPEN_ACCENT } from "../pi-extension/subagents/frame.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension from "../pi-extension/subagents/index.ts";

function render(details: any, content = "legacy response", expanded = false, width = 80) {
  const renderers = new Map<string, any>();
  extension({
    on() {},
    registerTool() {},
    registerCommand() {},
    registerShortcut() {},
    registerMessageRenderer(name: string, renderer: any) { renderers.set(name, renderer); },
    getAllTools() { return []; },
  } as any);
  const backgrounds: string[] = [];
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    bg: (color: string, text: string) => { backgrounds.push(color); return text; },
  };
  const component = renderers.get("subagent_result")(
    { content, details },
    { expanded, outputPad: 1 },
    theme,
  );
  const lines = component.render(width);
  component.invalidate();
  return { text: lines.join("\n"), lines, backgrounds };
}

describe("parent completion rendering", () => {
  it("registers the persisted assignment renderer on ordinary package load without child metadata", () => {
    const entryRenderers = new Map<string, any>();
    extension({
      on() {}, registerTool() {}, registerCommand() {}, registerShortcut() {},
      registerMessageRenderer() {}, getAllTools() { return []; },
      registerEntryRenderer(name: string, renderer: any) { entryRenderers.set(name, renderer); },
    } as any);
    const renderer = entryRenderers.get("subagent-assignment");
    assert.equal(typeof renderer, "function");
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const card = renderer({ data: {
      version: 1, childId: "old-child", sessionFile: "/tmp/old-session.jsonl",
      sender: "Parent agent", recipient: "Worker", role: "worker",
      task: "Persisted assignment on resume", skills: [],
    } }, { expanded: false }, theme);
    assert.ok(card.render(80).join("\n").includes("Persisted assignment on resume"));
  });
  it("shows sender, recipient, task and the entire response without expansion", () => {
    const response = Array.from({ length: 12 }, (_, i) => `response line ${i}`).join("\n");
    const { text } = render({ name: "Scout", agent: "researcher", task: "Inspect files", response });
    for (const value of ["Message from Scout (researcher)", "From: Scout (researcher)", "To: Parent", "Task:", "Inspect files", "Response:", ...response.split("\n")]) {
      assert.ok(text.includes(value), value);
    }
    assert.ok(!text.includes("to expand"));
    assert.ok(!text.includes("legacy response"));
  });

  it("wraps long response lines without losing the tail at narrow widths", () => {
    const { text, lines } = render({ name: "Worker", task: "Test", response: "界".repeat(60) + " END" }, "", false, 24);
    assert.ok(text.includes("END"));
    assert.equal((text.match(/界/g) ?? []).length, 60);
    assert.ok(lines.every((line: string) => visibleWidth(line) <= 24));
  });

  for (const details of [{ error: "watcher failed" }, { errorMessage: "provider failed" }, { exitCode: 2 }]) {
    it(`marks ${JSON.stringify(details)} as failed`, () => {
      const { text, backgrounds } = render({ name: "Worker", ...details });
      assert.ok(text.includes("failed"));
      assert.ok(!text.includes("completed"));
      assert.ok(backgrounds.includes("toolErrorBg"));
    });
  }

  for (const failed of [false, true]) {
    it(`uses an amber rounded frame and width-safe multiline Unicode content (${failed ? "failure" : "success"})`, () => {
      const details = {
        name: "Worker 🧑‍💻", task: "First line\nSecond line 日本語", response: "Café\n界".repeat(8) + " END",
        ...(failed ? { errorMessage: "provider failed" } : {}),
      };
      const wide = render(details);
      const frame = wide.lines.slice(1);
      assert.ok(frame[0].startsWith(`${OPEN_ACCENT}╭`));
      assert.ok(frame[0].includes(`Message from ${details.name}`));
      assert.ok(frame.at(-1).startsWith(`${OPEN_ACCENT}╰`));
      assert.ok(frame.slice(1, -1).every((line: string) => line.startsWith(`${OPEN_ACCENT}│`) && stripVTControlCharacters(line).endsWith("│")));
      for (const width of [0, 1, 2, 3, 4, 5, 8, 24, 80]) {
        const { lines, text } = render(details, "", false, width);
        assert.ok(lines.every((line: string) => visibleWidth(line) <= width), `width ${width}`);
        if (width >= 4) {
          assert.equal((text.match(/界/g) ?? []).length, 8);
          const plain = stripVTControlCharacters(text).replace(/[│\s]/g, "");
          assert.ok(plain.includes("END"));
          assert.ok(plain.includes("日本語"));
        }
      }
    });
  }

  it("renders legacy content and missing details without dropping the response", () => {
    const fallback = render(undefined, "old reply").text;
    assert.ok(fallback.includes("old reply"));
    assert.ok(fallback.includes("Message from subagent"));
    const { text } = render({ name: "Worker", elapsed: 1, exitCode: 0 }, 'Sub-agent "Worker" completed (1s).\n\nold reply\n\nSession: /tmp/session\nResume: pi --session /tmp/session');
    assert.ok(text.includes("old reply"));
    assert.ok(!text.includes("Sub-agent"));
    assert.ok(text.includes("(not recorded)"));
  });

  it("keeps response visible in both views and reveals session metadata on expansion", () => {
    const details = { name: "Worker", task: "Resume work", response: "Final reply", sessionFile: "/tmp/session", keepOpen: true, runtimePlan: { runtimeMismatch: "different model" } };
    const collapsed = render(details).text;
    const expanded = render(details, "", true).text;
    for (const text of [collapsed, expanded]) {
      assert.ok(text.includes("Final reply"));
      assert.ok(text.includes("Pane stayed open"));
      assert.ok(text.includes("Runtime warning: different model"));
    }
    assert.ok(!collapsed.includes("Session:"));
    assert.ok(expanded.includes("Session: /tmp/session"));
    assert.ok(expanded.includes("Resume: pi --session /tmp/session"));
  });

  it("shows an explicit placeholder for an empty structured response", () => {
    assert.ok(render({ response: "" }).text.includes("(no response)"));
  });
});
