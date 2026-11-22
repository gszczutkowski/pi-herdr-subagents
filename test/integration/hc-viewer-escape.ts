import assert from "node:assert/strict";
import { spawn } from "node:child_process";

// HC's public framed API, carried unchanged by `hc connect`. See wire.rs:
// https://github.com/herdrdev/herdr-core/blob/v0.1.21/crates/herdr-core/src/wire.rs
const HEADER = 9, MAX_PAYLOAD = 16 * 1024 * 1024, DATA = 0, CLOSE = 2;
function frame(channel: number, kind: number, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(HEADER);
  header.writeUInt32LE(channel);
  header[4] = kind;
  header.writeUInt32LE(payload.length, 5);
  return Buffer.concat([header, payload]);
}

/** Attach briefly as a viewer and deliver the literal Escape byte. Unlike
 * terminal.keys, viewer input does not wait for the automation quiet gate. */
export async function sendHcViewerEscape(executable: string, terminal: string, caller = process.env.HC_TERMINAL_ID): Promise<void> {
  assert.match(terminal, /^t[a-z0-9]+$/, "Escape requires an exact local HC terminal ID");
  assert.notEqual(terminal, caller, "Escape may not target the caller's terminal");
  const signal = AbortSignal.timeout(10_000);
  const relay = spawn(executable, ["connect"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, signal });
  let relayError: Error | undefined;
  relay.on("error", error => { relayError = error; });
  relay.stdin.on("error", error => { relayError ??= error; });
  const closed = new Promise<number | null>(resolve => relay.once("close", resolve));
  const request = (id: number, method: string, params: object) =>
    Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  let phase = "hello", channel = 0, detached = false, pending = Buffer.alloc(0);
  try {
    relay.stdin.write(Buffer.concat([request(0, "hello", { framed: true }), Buffer.from("\n")]));
    for await (const chunk of relay.stdout) {
      pending = Buffer.concat([pending, chunk]);
      if (phase === "hello") {
        const newline = pending.indexOf(10);
        assert.ok((newline < 0 ? pending.length : newline) <= MAX_PAYLOAD, "Oversized HC hello response");
        if (newline < 0) continue;
        const reply = JSON.parse(pending.subarray(0, newline).toString());
        assert.equal(reply.id, 0);
        assert.equal(reply.result?.framed, true, "HC must accept framed viewer connections");
        pending = pending.subarray(newline + 1);
        phase = "terminal.get";
        relay.stdin.write(frame(0, DATA, request(1, "terminal.get", { terminal })));
      }
      while (pending.length >= HEADER) {
        const stream = pending.readUInt32LE(), kind = pending[4], length = pending.readUInt32LE(5);
        assert.ok(length <= MAX_PAYLOAD, "Oversized HC frame");
        if (pending.length < HEADER + length) break;
        const payload = pending.subarray(HEADER, HEADER + length);
        pending = pending.subarray(HEADER + length);
        if (stream === 0 && kind === DATA) {
          const reply = JSON.parse(payload.toString());
          assert.ok(!reply.error, `HC ${phase} failed: ${reply.error?.message ?? "unknown error"}`);
          if (phase === "terminal.get") {
            assert.equal(reply.id, 1);
            const { address, state, cols, rows } = reply.result;
            assert.equal(address, terminal);
            assert.equal(state, "live");
            assert.ok([cols, rows].every(n => Number.isInteger(n) && n > 0 && n <= 65535));
            phase = "terminal.attach";
            // Preserve the terminal's current grid; do not focus or resize it.
            relay.stdin.write(frame(0, DATA, request(2, "terminal.attach", { terminal, cols, rows, caller })));
          } else {
            assert.equal(phase, "terminal.attach");
            assert.equal(reply.id, 2);
            assert.equal(reply.result?.terminal?.address, terminal);
            assert.equal(reply.result?.terminal?.state, "live");
            channel = reply.result.channel;
            assert.ok(Number.isInteger(channel) && channel > 0 && channel <= 0xffffffff);
            phase = "viewer detach";
            // No retry or interrupt fallback. The empty CLOSE reply confirms
            // the core consumed these frames in order, not that Pi aborted.
            relay.stdin.write(Buffer.concat([frame(channel, DATA, Buffer.from([0x1b])), frame(channel, CLOSE)]));
          }
        } else if (phase === "viewer detach" && stream === channel && kind === CLOSE) {
          assert.equal(length, 0, "HC closed the viewer before it detached");
          detached = true;
          relay.stdin.end();
        }
      }
    }
    const code = await closed;
    if (relayError) throw relayError;
    assert.ok(detached && code === 0, `HC connect exited before clean detach (exit ${code})`);
  } catch (error) {
    throw new Error(`HC viewer Escape failed during ${phase}${signal.aborted ? " (deadline exceeded)" : ""}: ${relayError ?? error}`, { cause: error });
  } finally {
    // Terminate only our short-lived `hc connect` relay on failure, never the target.
    if (!relay.stdin.writableEnded) relay.stdin.end();
    if (relay.exitCode === null && relay.signalCode === null) relay.kill();
    await closed;
  }
}
