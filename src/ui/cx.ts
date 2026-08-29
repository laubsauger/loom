/** Minimal class-name joiner. No dependency, no variant DSL — we don't need one. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
