import { relative, sep } from "node:path";
import { readEnv } from "@fcx/config";
import type { GlobalArgs } from "./args.js";
import type { IndexReport } from "./commands/index.js";
import { resolveFcxConfig } from "./lib/config.js";
import { meta } from "./meta.js";
import { emit } from "./output.js";

export const HELP = `Usage: fcx [global flags] <command> [args]

Global flags:
  --output-format text|json
  --permission-mode MODE    read-only | workspace-write | prompt | danger-full-access
  --no-escalate             never offer a hosted escalation in this run
  -C <path>                 run as if started in <path>
  -h, --help
  -v, --version

Commands:
  status                    Show resolved config, trust, policy and permission mode
  doctor                    Run health checks
  fix <file[:line]>         Fix the first error in a file, or the one at a line
  fix-test <file> --name <test> [--output <text>]
                            Fix a failing test. fcx runs no tests: the failure text comes from --output
  test | write-test <file:symbol>
                            Write a unit test for one symbol. Creates the test file.
  create <file> "<desc>"    Create a new file with AI-generated content from a description.
  implement <file:line>     Write the body of the stub function at a line
  types <file[:symbol]>     Add missing type annotations (TypeScript). Without a symbol, the whole file
  doc <file:line>           Write a doc comment for the declaration at a line
  refactor <file:start-end> "<instruction>"
                            Make a small refactor of a selected range, following the instruction
  rename <file:line:column> [new-name]
                            Rename a symbol (TypeScript). Without a name, the model proposes one
  explain <file:start-end> ["<question>"]
                            Explain a selection, citing the lines it uses, or answer a question about it
  commit [--apply]          Write a commit message for staged changes. --apply runs git commit after a yes
  ask "<text>"              Route a task to a recipe. Commit messages run; other recipes print their command
  undo                      Undo the last applied change
  tui                       Open the interactive terminal UI (also: bare fcx in a terminal)
  trust [path]              Trust a workspace (default: current directory) so its project settings and language servers apply
  memory list|forget|clear  Show, delete or clear local memory   [--kind K] [<id>]
  index [--rebuild|--status] Build, rebuild or show the code index
  init [path]               Create .frontal-code/ with settings in a project (never overwrites)
  models list|pull|bench    List, download or benchmark local models (see docs/MODELS.md)
  acp                       Start the ACP server on stdin/stdout (for editors). Logs go to stderr.

Exit codes: 0 applied/proposed/answered/routed, 1 error (also no staged changes, or unsupported),
2 abstained, 3 declined, 4 escalation declined.`;

export const NOT_IMPLEMENTED = new Set<string>();

type CommandHandler = (args: GlobalArgs, cwd: string) => Promise<number>;

/**
 * Recipe commands. Each module loads on first use, so `--help`, `status` and `doctor` never load a parser or a
 * model. Every handler goes through the warm-server hook in `run` first, like every other command.
 */
const RECIPE_COMMANDS: ReadonlyMap<string, CommandHandler> = new Map<string, CommandHandler>([
  [
    "test",
    async (args, cwd) => (await import("./commands/write-test.js")).runWriteTestCli(args, cwd),
  ],
  [
    "write-test",
    async (args, cwd) => (await import("./commands/write-test.js")).runWriteTestCli(args, cwd),
  ],
  [
    "fix-test",
    async (args, cwd) => (await import("./commands/fix-test.js")).runFixTestCli(args, cwd),
  ],
  ["create", async (args, cwd) => (await import("./commands/create.js")).runCreateCli(args, cwd)],
  [
    "implement",
    async (args, cwd) => (await import("./commands/implement.js")).runImplementCli(args, cwd),
  ],
  ["types", async (args, cwd) => (await import("./commands/types.js")).runTypesCli(args, cwd)],
  ["doc", async (args, cwd) => (await import("./commands/doc.js")).runDocCli(args, cwd)],
  [
    "refactor",
    async (args, cwd) => (await import("./commands/refactor.js")).runRefactorCli(args, cwd),
  ],
  ["rename", async (args, cwd) => (await import("./commands/rename.js")).runRenameCli(args, cwd)],
  [
    "explain",
    async (args, cwd) => (await import("./commands/explain.js")).runExplainCli(args, cwd),
  ],
  ["commit", async (args, cwd) => (await import("./commands/commit.js")).runCommitCli(args, cwd)],
  ["ask", async (args, cwd) => (await import("./commands/ask.js")).runAskCli(args, cwd)],
  ["acp", async (args) => (await import("./commands/acp.js")).runAcpCli(args)],
]);

/** True when both stdin and stdout are terminals, so an interactive UI can read keys and draw. */
function isTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export async function run(args: GlobalArgs): Promise<number> {
  if (args.version) {
    console.log(meta.version);
    return 0;
  }
  if (args.command === "tui" || (args.command === undefined && !args.help && isTerminal())) {
    const { runTui } = await import("./lib/tui.js");
    return runTui((next) => run(next), args.cwd ?? process.cwd());
  }

  if (args.help || args.command === undefined) {
    console.log(HELP);
    return 0;
  }

  // Routing hook: a warm server that answers runs the command; otherwise it runs in-process below.
  const { routeToWarmServer } = await import("./lib/client.js");
  const warmExit = await routeToWarmServer(args);
  if (warmExit !== undefined) return warmExit;

  const cwd = args.cwd ?? process.cwd();
  const { outputFormat, permissionMode } = args;

  if (args.command === "status") {
    const { status, formatStatus } = await import("./commands/status.js");
    const report = status(cwd, permissionMode);
    emit(outputFormat, report, () => formatStatus(report));
    return 0;
  }

  if (args.command === "doctor") {
    const { doctor, formatDoctor } = await import("./commands/doctor.js");
    const report = await doctor(cwd, permissionMode);
    emit(outputFormat, report, () => formatDoctor(report));
    return report.status === "fail" ? 1 : 0;
  }

  if (args.command === "fix") {
    return runFix(args, cwd);
  }

  const recipeHandler = RECIPE_COMMANDS.get(args.command);
  if (recipeHandler) return recipeHandler(args, cwd);

  if (args.command === "undo") {
    return runUndo(args, cwd);
  }

  if (args.command === "trust") {
    const { runTrustCommand } = await import("./commands/trust.js");
    return runTrustCommand(args, cwd);
  }

  if (args.command === "serve") {
    const { runServe } = await import("./lib/serve.js");
    return runServe(args, cwd);
  }

  if (args.command === "memory") {
    return runMemoryCommand(args, cwd);
  }

  if (args.command === "index") {
    return runIndexCommand(args, cwd);
  }

  if (args.command === "init") {
    const { runInitCommand } = await import("./commands/init.js");
    return runInitCommand(args, cwd);
  }

  if (args.command === "models") {
    const { runModelsCommand } = await import("./commands/models.js");
    return runModelsCommand(args);
  }

  if (NOT_IMPLEMENTED.has(args.command)) {
    const error = { status: "error", code: "NOT_IMPLEMENTED", command: args.command };
    emit(outputFormat, error, () => `fcx ${args.command}: not implemented yet`);
    return 1;
  }

  console.error(`Unknown command: ${args.command}`);
  console.error(`Run "fcx --help" for usage.`);
  return 1;
}

export async function runFix(args: GlobalArgs, cwd: string): Promise<number> {
  const target = args.rest[0];
  if (!target) {
    console.error("usage: fcx fix <file[:line]>");
    return 1;
  }
  const { runFixCommand, exitCodeFor } = await import("./commands/fix.js");
  const { createModelHost, candidateBudget } = await import("./lib/runtime.js");
  const { askToApply, askToEscalate } = await import("./lib/approval.js");
  const { undoRootFor, memoryPathFor } = await import("./lib/repo.js");
  const { formatFix } = await import("./lib/format.js");

  const resolved = resolveFcxConfig(cwd, { permissionMode: args.permissionMode });
  // Escalation needs a person at the terminal to say yes. Without one it is never offered.
  const { escalationOptionFor } = await import("./lib/escalation.js");
  const escalation = escalationOptionFor({
    noEscalate: args.noEscalate,
    enabled: resolved.local.escalation?.enabled !== false,
    isTTY: process.stdin.isTTY === true,
    projectConfig: resolved.projectConfig,
    policy: resolved.policy,
    env: readEnv(),
    offer: askToEscalate,
  });

  const report = await runFixCommand({
    workspace: cwd,
    target,
    permissionMode: resolved.permissionMode,
    dryRun: args.dryRun,
    maxCandidates: candidateBudget(resolved.local),
    model: await createModelHost(resolved.local),
    approve: (proposal) => askToApply(proposal),
    undoRoot: undoRootFor(resolved.paths.cacheDir, cwd),
    logsDir: resolved.paths.logsDir,
    memoryPath: memoryPathFor(resolved.paths.cacheDir, cwd),
    escalation,
    trusted: resolved.trust.trusted,
  });
  emit(args.outputFormat, report, () => formatFix(report));
  return exitCodeFor(report.status);
}

export async function runUndo(args: GlobalArgs, cwd: string): Promise<number> {
  const { applyUndo } = await import("./lib/undo.js");
  const { rememberSafely } = await import("./lib/memory.js");
  const { memoryPathFor } = await import("./lib/repo.js");
  const resolved = resolveFcxConfig(cwd, { permissionMode: args.permissionMode });
  const result = applyUndo(resolved.paths.cacheDir, cwd);
  if (result.status !== "ok") {
    emit(args.outputFormat, result, () => `undo failed: ${result.message}`);
    return 1;
  }

  // Memory is advisory: a failed write becomes a warning and the undo still succeeds.
  const warnings: string[] = [];
  const warning = await rememberSafely(memoryPathFor(resolved.paths.cacheDir, cwd), (store) => {
    for (const file of result.restored) {
      store.recordRejected({
        text: `user undid fcx change ${result.undoId}`,
        filePath: relative(cwd, file).split(sep).join("/"),
      });
    }
  });
  if (warning) warnings.push(warning);

  const report = { ...result, warnings };
  emit(args.outputFormat, report, () => {
    const lines = [`restored ${result.restored.length} file(s)`];
    for (const w of warnings) lines.push(`warning: ${w}`);
    return lines.join("\n");
  });
  return 0;
}

async function runMemoryCommand(args: GlobalArgs, cwd: string): Promise<number> {
  const { runMemory, formatMemory, memoryExitCode } = await import("./commands/memory.js");
  const { memoryPathFor } = await import("./lib/repo.js");
  const resolved = resolveFcxConfig(cwd, { permissionMode: args.permissionMode });
  const report = runMemory(args.rest, memoryPathFor(resolved.paths.cacheDir, cwd));
  emit(args.outputFormat, report, () => formatMemory(report));
  return memoryExitCode(report);
}

async function runIndexCommand(args: GlobalArgs, cwd: string): Promise<number> {
  const { parseIndexArgs, runIndex, formatIndex } = await import("./commands/index.js");
  const { indexPathFor } = await import("./lib/repo.js");
  const parsed = parseIndexArgs(args.rest);
  if (typeof parsed === "string") {
    const report = { status: "error" as const, code: "USAGE", message: parsed };
    emit(args.outputFormat, report, () => formatIndex(report));
    return 1;
  }
  const resolved = resolveFcxConfig(cwd, { permissionMode: args.permissionMode });
  const report = await runIndex(
    parsed,
    cwd,
    indexPathFor(resolved.paths.cacheDir, cwd),
    resolved.local.index?.exclude ?? [],
  ).catch(
    (error: unknown): IndexReport => ({
      status: "error",
      code: "INDEX_FAILED",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  emit(args.outputFormat, report, () => formatIndex(report));
  return report.status === "ok" ? 0 : 1;
}
