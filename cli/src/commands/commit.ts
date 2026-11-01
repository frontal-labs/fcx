export interface CommitOptions {
  apply: boolean;
}

export function commit(argv: string[]): CommitOptions {
  return { apply: argv.includes("--apply") };
}
