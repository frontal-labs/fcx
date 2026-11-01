export function doc(argv: string[]): { symbol?: string } {
  return { symbol: argv[0] };
}
