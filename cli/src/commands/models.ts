export interface ModelsOptions {
  subcommand: "list" | "pull" | "bench" | undefined;
  model?: string;
}

export function models(argv: string[]): ModelsOptions {
  const sub = argv[0];
  if (sub === "list" || sub === "pull" || sub === "bench") {
    return { subcommand: sub, model: argv[1] };
  }
  return { subcommand: undefined, model: sub };
}
