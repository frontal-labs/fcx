export function ask(argv: string[]): { question?: string } {
  return { question: argv[0] };
}
