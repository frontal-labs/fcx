export interface FixOptions {
  file?: string;
  line?: number;
}

export function fix(argv: string[]): FixOptions {
  const target = argv[0];
  let file: string | undefined;
  let line: number | undefined;

  if (target) {
    const parts = target.split(":");
    file = parts[0];
    if (parts[1]) {
      line = Number.parseInt(parts[1], 10);
      if (Number.isNaN(line)) {
        line = undefined;
      }
    }
  }

  return { file, line };
}
