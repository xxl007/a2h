/** Joins CSS-module class names; undefined entries (unknown keys) are dropped. */
export function cx(...names: Array<string | false | undefined>): string {
  return names.filter(Boolean).join(" ");
}
