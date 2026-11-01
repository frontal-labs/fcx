export function refactor(argv: string[]): { instruction?: string } {
  return { instruction: argv[0] };
}
