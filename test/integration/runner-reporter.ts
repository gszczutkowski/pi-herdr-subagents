import { resolve } from "node:path";
import { Readable } from "node:stream";
import type { TestsStream } from "node:test";
import { spec } from "node:test/reporters";

type Event = TestsStream extends AsyncIterable<infer T> ? T : never;

export default async function* report(source: AsyncIterable<Event>) {
  let executed = 0;
  async function* observe() {
    for await (const event of source) {
      if (event.type === "test:pass" || event.type === "test:fail") {
        const data = event.data;
        // Node emits a synthetic passing test at 1:1 named after the file when
        // the file loads but a name filter matches no scenarios inside it.
        const fileOnly = data.file && data.line === 1 && data.column === 1 && resolve(data.name) === resolve(data.file);
        if (data.details.type === "test" && !data.skip && !data.todo && !fileOnly) executed++;
      }
      yield event;
    }
  }
  yield* Readable.from(observe()).pipe(spec());
  if (!executed) {
    yield "No integration test cases executed; check the name filter and test prerequisites.\n";
    process.exitCode = 1;
  }
}
