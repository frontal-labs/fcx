/**
 * Step 3 of the MLX held-out comparison. Scores one completions file on the TEST split with the same criterion as
 * evals/run.ts: a task passes when the fix is applied and the target file has no type errors afterwards.
 *
 * For each task with a model prompt, a scripted model returns the completion for that task. The completion must
 * match the recorded prompt exactly (a mismatch is an error, not a pass). Its text is parsed as JSON; a parse failure
 * is a schema error for that task, which the engine handles as a failed candidate. Tasks resolved by the compiler
 * quick fix never call the scripted model.
 *
 * Parse modes:
 *   strict        (headline) the completion must be bare JSON, parsed as-is.
 *   fence-stripped (sensitivity only) a single surrounding Markdown code fence is removed before JSON.parse.
 *
 * Usage: bun training/src/score-mlx.ts --completions training/eval-mlx/<label>-completions.jsonl --label <label>
 *        [--parse strict|fence-stripped] [--prompts training/eval-mlx/test-prompts.jsonl] [--out <file>]
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runFixCommand } from "../../cli/src/commands/fix.ts";
import { createTsChecker, errorsOnly } from "../../packages/verify/src/index.ts";
import { type Task, materialize, tasksRoot } from "./pipeline.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const repoRoot = resolve(tasksRoot(), "..", "..");
const label = flag("--label");
const completionsFile = flag("--completions");
if (!label || !completionsFile) throw new Error("usage: --completions <file> --label <name>");
const parseMode = flag("--parse") ?? "strict";
if (parseMode !== "strict" && parseMode !== "fence-stripped")
  throw new Error("--parse strict|fence-stripped");
const promptsFile = resolve(
  flag("--prompts") ?? join(repoRoot, "training/eval-mlx/test-prompts.jsonl"),
);
const outFile = resolve(
  flag("--out") ?? join(repoRoot, "training/eval-mlx", `${label}-scores-${parseMode}.json`),
);

interface PromptRow {
  id: string;
  split: string;
  category: string;
  family: string | undefined;
  kind: "model" | "compiler" | "other";
  prompt: string | undefined;
  criterion: { files: Record<string, string>; target: string };
}

const readJsonl = <T>(file: string): T[] =>
  readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);

const rows = readJsonl<PromptRow>(promptsFile);
const completions = new Map<string, string>();
for (const c of readJsonl<{ id: string; completion: string }>(resolve(completionsFile))) {
  if (completions.has(c.id)) throw new Error(`duplicate completion for ${c.id}`);
  completions.set(c.id, c.completion);
}

/** Removes one surrounding ```json ... ``` fence, if the whole output is a single fenced block. */
function stripFence(text: string): string {
  const m = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return m?.[1] ?? text;
}

interface TaskScore {
  id: string;
  category: string;
  kind: PromptRow["kind"];
  pass: boolean;
  status: string;
  candidateSource: string | undefined;
  remainingErrors: number;
  missingCompletion: boolean;
  promptMismatch: boolean;
  parseError: boolean;
  error?: string;
}

const scores: TaskScore[] = [];
for (const row of rows) {
  const task: Task = {
    id: row.id,
    split: row.split,
    category: row.category,
    files: row.criterion.files,
    target: row.criterion.target,
  };
  const workspace = materialize(task);
  const flags = { missingCompletion: false, promptMismatch: false, parseError: false };
  const scripted = {
    generateObject: async (req: { prompt: string }) => {
      if (row.kind !== "model" || row.prompt === undefined) {
        throw new Error(`unexpected model call for ${row.id} (kind ${row.kind})`);
      }
      if (req.prompt !== row.prompt) {
        flags.promptMismatch = true;
        throw new Error("prompt mismatch with the recorded prompt");
      }
      const completion = completions.get(row.id);
      if (completion === undefined) {
        flags.missingCompletion = true;
        throw new Error("no completion for this task");
      }
      const text = parseMode === "fence-stripped" ? stripFence(completion) : completion;
      let object: unknown;
      try {
        object = JSON.parse(text.trim());
      } catch {
        flags.parseError = true;
        // Schema error for this candidate: the engine records it and does not apply anything.
        throw new Error("schema error: output is not JSON");
      }
      return { object, ms: 0, raw: text };
    },
  };
  const targetRel = row.criterion.target.split(":")[0] as string;
  try {
    const report = await runFixCommand({
      workspace,
      target: row.criterion.target,
      permissionMode: "workspace-write",
      dryRun: false,
      maxCandidates: 1,
      model: scripted as never,
      approve: async () => false,
      undoRoot: join(workspace, ".undo"),
      logsDir: join(workspace, ".logs"),
    });
    const checker = createTsChecker(workspace, join(workspace, targetRel));
    const remaining = errorsOnly(checker.diagnostics(join(workspace, targetRel))).length;
    checker.dispose();
    const accepted = report.candidates.find((c) => c.pass);
    scores.push({
      id: row.id,
      category: row.category,
      kind: row.kind,
      pass: report.status === "applied" && remaining === 0,
      status: report.status,
      candidateSource: accepted?.source ?? report.candidates[0]?.source,
      remainingErrors: remaining,
      ...flags,
      error: report.error?.message,
    });
  } catch (error) {
    scores.push({
      id: row.id,
      category: row.category,
      kind: row.kind,
      pass: false,
      status: "error",
      candidateSource: undefined,
      remainingErrors: -1,
      ...flags,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
  console.log(
    `${row.id}: ${scores[scores.length - 1]?.status} pass=${scores[scores.length - 1]?.pass} ` +
      `source=${scores[scores.length - 1]?.candidateSource ?? "-"}`,
  );
}

const count = (xs: TaskScore[]) => ({ passed: xs.filter((s) => s.pass).length, total: xs.length });
const modelSet = scores.filter((s) => s.kind === "model");
const compilerSet = scores.filter((s) => s.kind === "compiler");
const byCategory = Object.fromEntries(
  [...new Set(modelSet.map((s) => s.category))]
    .sort()
    .map((c) => [c, count(modelSet.filter((s) => s.category === c))]),
);
const summary = {
  label,
  completions: completionsFile,
  parse: parseMode,
  generatedAt: new Date().toISOString(),
  modelComparison: { ...count(modelSet), byCategory },
  compilerResolved: count(compilerSet),
  overallIncludingCompiler: count(scores),
  acceptedFromModel: scores.filter((s) => s.pass && s.candidateSource === "model").length,
  acceptedFromCompiler: scores.filter((s) => s.pass && s.candidateSource === "compiler").length,
  diagnostics: {
    missingCompletion: scores.filter((s) => s.missingCompletion).length,
    promptMismatch: scores.filter((s) => s.promptMismatch).length,
    parseError: scores.filter((s) => s.parseError).length,
    errors: scores.filter((s) => s.status === "error").length,
  },
  scores,
};
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`);
console.log(
  `\n${label} [${parseMode}] model set: ${count(modelSet).passed}/${modelSet.length}; ` +
    `compiler: ${count(compilerSet).passed}/${compilerSet.length}. Wrote ${outFile}`,
);
