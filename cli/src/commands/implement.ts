export function implement(argv: string[]): { symbol?: string } {
  return { symbol: argv[0] };
}
