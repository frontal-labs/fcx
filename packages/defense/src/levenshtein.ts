/** Edit distance (insertions, deletions, substitutions), two-row dynamic programming. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      curr.push(Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = curr;
  }
  return prev[b.length] ?? 0;
}

/**
 * The nearest names to `target`, at most `limit`. A name is a candidate only when its distance is within
 * `max(2, floor(target.length / 3))`, so a far-off name is not suggested. Ties sort alphabetically.
 */
export function nearestNames(target: string, names: Iterable<string>, limit = 3): string[] {
  const threshold = Math.max(2, Math.floor(target.length / 3));
  const scored = new Map<string, number>();
  for (const name of names) {
    if (name === target || scored.has(name)) continue;
    const distance = levenshtein(target, name);
    if (distance <= threshold) scored.set(name, distance);
  }
  return [...scored.entries()]
    .sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .slice(0, limit)
    .map(([name]) => name);
}
