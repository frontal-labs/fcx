export function rename(argv: string[]): { newName?: string } {
  return { newName: argv[0] };
}
