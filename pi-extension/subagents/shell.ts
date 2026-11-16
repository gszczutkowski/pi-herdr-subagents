/** Metadata is data, never executable preamble. Cover CR, LF and CRLF. */
export function shellComment(value: string): string {
  return value.split(/\r\n|\r|\n/).map((line) => `# ${line}`).join("\n");
}
