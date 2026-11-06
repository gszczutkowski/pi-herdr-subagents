import { isAbsolute, join } from "node:path";

/** Use native path semantics: Windows drive/UNC paths are absolute too. */
export function resolveSubagentCwd(
  rawCwd: string | null,
  base: string,
  paths = { isAbsolute, join },
): string | null {
  return rawCwd ? paths.isAbsolute(rawCwd) ? rawCwd : paths.join(base, rawCwd) : null;
}
