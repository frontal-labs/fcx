export interface IndexOptions {
  rebuild: boolean;
  status: boolean;
}

export function index(argv: string[]): IndexOptions {
  return {
    rebuild: argv.includes("--rebuild"),
    status: argv.includes("--status"),
  };
}
