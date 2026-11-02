/**
 * Runs the fix-diagnostic eval set against the real local model.
 *
 * Usage: bun evals/run.ts [--filter <substring>] [--out <file>]
 *
 * For each task: materialize the project in a temp directory, run the fix command on the target line with
 * workspace-write permission, then type-check the target file. A task passes when the fix was applied and the
 * file has no type errors afterwards. Tasks run one at a time, because each one loads the model.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type FixReport, runFixCommand } from "../cli/src/commands/fix.ts";
import { candidateBudget } from "../cli/src/lib/runtime.ts";
import { GgmlNodeModelHost } from "../packages/model/src/index.ts";
import { createTsChecker, errorsOnly } from "../packages/verify/src/index.ts";

interface Task {
  id: string;
  category: string;
  files: Record<string, string>;
  target: string;
}

interface Result {
  id: string;
  category: string;
  status: FixReport["status"];
  pass: boolean;
  candidateSource: string | undefined;
  candidates: number;
  totalMs: number;
  remainingErrors: number;
  error?: string;
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const filter = flag("--filter") ?? "";
const taskDir = resolve(
  dirname(new URL(import.meta.url).pathname),
  "tasks",
  "ts",
  "fix-diagnostic-local",
);
const outFile =
  flag("--out") ??
  join(resolve(dirname(new URL(import.meta.url).pathname), "reports"), `local-${Date.now()}.json`);

const tasks: Task[] = readdirSync(taskDir)
  .filter((f) => f.endsWith(".json") && f.includes(filter))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(taskDir, f), "utf-8")) as Task);

const model = new GgmlNodeModelHost({});
const results: Result[] = [];

for (const task of tasks) {
  const workspace = mkdtempSync(join(tmpdir(), `fcx-eval-${task.id}-`));
  const undoRoot = join(workspace, ".undo");
  const logsDir = join(workspace, ".logs");
  try {
    for (const [path, content] of Object.entries(task.files)) {
      mkdirSync(dirname(join(workspace, path)), { recursive: true });
      writeFileSync(join(workspace, path), content);
    }
    const report = await runFixCommand({
      workspace,
      target: task.target,
      permissionMode: "workspace-write",
      dryRun: false,
      maxCandidates: candidateBudget({ maxCandidates: "auto" } as never),
      model,
      approve: async () => false,
      undoRoot,
      logsDir,
    });

    const targetFile = join(workspace, task.target.split(":")[0] as string);
    const checker = createTsChecker(workspace, targetFile);
    const remaining = errorsOnly(checker.diagnostics(targetFile)).length;
    checker.dispose();

    results.push({
      id: task.id,
      category: task.category,
      status: report.status,
      pass: report.status === "applied" && remaining === 0,
      candidateSource:
        report.candidates.find((c) => c.pass)?.source ?? report.candidates[0]?.source,
      candidates: report.candidates.length,
      totalMs: report.timings.totalMs,
      remainingErrors: remaining,
      error: report.error?.message,
    });
    console.log(
      `${task.id}: ${report.status} pass=${report.status === "applied" && remaining === 0} ${report.timings.totalMs}ms`,
    );
  } catch (error) {
    results.push({
      id: task.id,
      category: task.category,
      status: "error",
      pass: false,
      candidateSource: undefined,
      candidates: 0,
      totalMs: 0,
      remainingErrors: -1,
      error: error instanceof Error ? error.message : String(error),
    });
    console.log(`${task.id}: harness error ${String(error)}`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

await model.shutdown();

const passed = results.filter((r) => r.pass).length;
const summary = {
  model: "ggml/auto (qwen2.5-1.5b-instruct-q4_k_m)",
  generatedAt: new Date().toISOString(),
  total: results.length,
  passed,
  passRate: results.length === 0 ? 0 : passed / results.length,
  byCategory: Object.fromEntries(
    [...new Set(results.map((r) => r.category))].map((c) => {
      const rs = results.filter((r) => r.category === c);
      return [c, { passed: rs.filter((r) => r.pass).length, total: rs.length }];
    }),
  ),
  medianMs:
    [...results].map((r) => r.totalMs).sort((a, b) => a - b)[Math.floor(results.length / 2)] ?? 0,
  results,
};
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\n${passed}/${results.length} passed. Report: ${outFile}`);
