/** Locale-independent string comparison, so sorted output is the same on every machine. */
export function compareText(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}
