import { meta } from "./meta.js";

const COMMANDS = new Set([
  "fix",
  "fix-test",
  "test",
  "write-test",
  "implement",
  "types",
  "doc",
  "refactor",
  "rename",
  "explain",
  "commit",
  "ask",
  "undo",
  "index",
  "init",
  "models",
  "status",
  "doctor",
  "acp",
]);

type CommandHandler = (rest: string[]) => Promise<void>;

const handlers: Record<string, CommandHandler> = {
  status: async () => {
    const { status } = await import("./commands/status.js");
    console.log(JSON.stringify(status()));
  },
  doctor: async () => {
    const { doctor } = await import("./commands/doctor.js");
    console.log(JSON.stringify(doctor()));
  },
  fix: async (rest) => {
    const { fix } = await import("./commands/fix.js");
    console.log(JSON.stringify(fix(rest)));
  },
  "fix-test": async (rest) => {
    const { fixTest } = await import("./commands/fix-test.js");
    console.log(JSON.stringify(fixTest(rest)));
  },
  test: async (rest) => {
    const { writeTest } = await import("./commands/write-test.js");
    console.log(JSON.stringify(writeTest(rest)));
  },
  "write-test": async (rest) => {
    const { writeTest } = await import("./commands/write-test.js");
    console.log(JSON.stringify(writeTest(rest)));
  },
  implement: async (rest) => {
    const { implement } = await import("./commands/implement.js");
    console.log(JSON.stringify(implement(rest)));
  },
  types: async (rest) => {
    const { addTypes } = await import("./commands/types.js");
    console.log(JSON.stringify(addTypes(rest)));
  },
  doc: async (rest) => {
    const { doc } = await import("./commands/doc.js");
    console.log(JSON.stringify(doc(rest)));
  },
  refactor: async (rest) => {
    const { refactor } = await import("./commands/refactor.js");
    console.log(JSON.stringify(refactor(rest)));
  },
  rename: async (rest) => {
    const { rename } = await import("./commands/rename.js");
    console.log(JSON.stringify(rename(rest)));
  },
  explain: async (rest) => {
    const { explain } = await import("./commands/explain.js");
    console.log(JSON.stringify(explain(rest)));
  },
  commit: async (rest) => {
    const { commit } = await import("./commands/commit.js");
    console.log(JSON.stringify(commit(rest)));
  },
  ask: async (rest) => {
    const { ask } = await import("./commands/ask.js");
    console.log(JSON.stringify(ask(rest)));
  },
  undo: async () => {
    const { undo } = await import("./commands/undo.js");
    console.log(JSON.stringify(undo()));
  },
  index: async (rest) => {
    const { index } = await import("./commands/index.js");
    console.log(JSON.stringify(index(rest)));
  },
  init: async () => {
    const { init } = await import("./commands/init.js");
    console.log(JSON.stringify(init()));
  },
  models: async (rest) => {
    const { models } = await import("./commands/models.js");
    console.log(JSON.stringify(models(rest)));
  },
  acp: async () => {
    const { acp } = await import("./commands/acp.js");
    console.log(JSON.stringify(acp()));
  },
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    printHelp();
    process.exit(0);
  }

  if (cmd === "--version" || cmd === "-v") {
    console.log(meta.version);
    process.exit(0);
  }

  if (!COMMANDS.has(cmd)) {
    console.error(`Unknown command: ${cmd}`);
    console.error(`Run "fcx --help" for usage.`);
    process.exit(1);
  }

  const rest = args.slice(1);
  const handler = handlers[cmd];
  if (handler) {
    await handler(rest);
  }
  process.exit(0);
}

function printHelp(): void {
  console.log(`Usage: fcx [global flags] <command> [args]

Global flags:
  --output-format text|json
  --permission-mode MODE
  --model ggml/<id>
  --dry-run
  --no-escalate
  -C <path>

Commands:
  fix [file[:line]]     Fix diagnostic(s) in a file
  fix-test              Fix a failing test
  test | write-test     Write a test for a symbol
  implement             Implement a stub function
  types                 Add types to a symbol/file
  doc                   Write a docstring
  refactor              Refactor a selection
  rename [new-name]     Rename a symbol
  explain [question]    Explain code
  commit [--apply]      Generate a commit message
  ask [question]        Ask a routing question
  undo                  Undo the last task
  index [--rebuild] [--status]  Rebuild or show index status
  init                  Initialize fcx in a project
  models list|pull|bench  Manage models
  status                Show status
  doctor                Run health checks
  acp                   Start ACP server`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
