export function fixTest(argv: string[]): { test?: string } {
  return { test: argv[0] };
}
