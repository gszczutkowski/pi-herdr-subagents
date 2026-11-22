import type { TestEvent } from "node:test";
import { inspect } from "node:util";

/** Quiet output for successful tests; retain failure errors, causes and stacks. */
export default async function* report(source: AsyncIterable<TestEvent>) {
  for await (const event of source) {
    if (event.type === "test:fail" && !event.data.skip && !event.data.todo) {
      const { name, file, line, column, details } = event.data;
      yield `FAIL ${name}\n${file ?? "<unknown>"}:${line ?? 0}:${column ?? 0}\n${inspect(details.error, { colors: false, depth: null })}\n\n`;
    } else if (event.type === "test:summary" && event.data.file === undefined) {
      const { tests, passed, skipped, todo } = event.data.counts;
      // TODO cases are not executed successfully; cancellations count as failures.
      yield `passed: ${passed}, skipped: ${skipped + todo}, failed: ${tests - passed - skipped - todo}\n`;
    }
  }
}
