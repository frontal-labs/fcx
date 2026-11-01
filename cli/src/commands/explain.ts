export function explain(argv: string[]): { question?: string } {
  return { question: argv[0] };
}
