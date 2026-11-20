const slots = globalThis as typeof globalThis & Record<symbol, unknown>;

/** Typed access to an extension-owned process slot that survives module reload.
 * Keep the registered name and value shape stable across reloads. */
export function globalStateSlot<T>(name: string) {
  const key = Symbol.for(name);
  return {
    get value(): T | undefined { return slots[key] as T | undefined; },
    set value(value: T | undefined) { slots[key] = value; },
  };
}
