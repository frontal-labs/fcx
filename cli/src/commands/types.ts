export function addTypes(argv: string[]): { symbol?: string } {
  return { symbol: argv[0] };
}
