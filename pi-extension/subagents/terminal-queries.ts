/** Shared process budget for asynchronous terminal discovery, reads and inspections. */
export const MAX_TERMINAL_QUERIES = 4;
export const TERMINAL_QUERY_TIMEOUT_MS = 15_000;

let active = 0;
const waiting: Array<() => void> = [];

export async function withTerminalQuery<T>(query: () => Promise<T>): Promise<T> {
  if (active >= MAX_TERMINAL_QUERIES) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    active++;
  }
  try {
    return await query();
  } finally {
    // Transfer the slot directly to the oldest waiter, including on failure.
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
