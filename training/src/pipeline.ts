/**
 * Shared task runner for training data collection and evaluation.
 *
 * It runs the real fix command (the same code path as evals/run.ts), records every model call the engine makes,
 * and checks the result with the same metric: status "applied" and no type errors left in the target file.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { type FixReport, runFixCommand } from "../../cli/src/commands/fix.ts";
import { candidateBudget } from "../../cli/src/lib/runtime.ts";
import type { ModelHost } from "../../packages/model/src/index.ts";
import { runFixDiagnostic } from "../../packages/recipes/src/index.ts";
import { createTsChecker, errorsOnly } from "../../packages/verify/src/index.ts";

export interface Task {
  id: string;
  split: string;
  family?: string;
  category: string;
  files: Record<string, string>;
  target: string;
}

export interface Edit {
  file: string;
  search: string;
  replace: string;
}

/** One successful model call, as the engine saw it: the exact prompt string and the parsed output. */
export interface RecordedCall {
  prompt: string;
  edits: Edit[];
}

/** A model wrapper that records every successful generateObject call, in order. */
export function recordingModel(inner: Pick<ModelHost, "generateObject">) {
  const calls: RecordedCall[] = [];
  const model: Pick<ModelHost, "generateObject"> = {
    generateObject: async <T>(req: {
      schema: unknown;
      prompt: string;
      temperature?: number;
      maxTokens?: number;
    }) => {
      const result = await inner.generateObject<T>(req);
      const edits = (result.object as { edits?: Edit[] }).edits ?? [];
      calls.push({ prompt: req.prompt, edits });
      return result;
    },
  };
  return { model, calls };
}

export interface TaskOutcome {
  id: string;
  category: string;
  split: string;
  status: FixReport["status"];
  pass: boolean;
  candidateSource: "compiler" | "model" | undefined;
  /** Index among the accepted candidate's model calls, when the accepted candidate came from the model. */
  acceptedModelCallIndex: number | undefined;
  candidates: number;
  modelCalls: number;
  totalMs: number;
  remainingErrors: number;
  error?: string;
  /** The recorded model calls (training data source). Not written to eval reports. */
  calls: RecordedCall[];
  /** The accepted edits, with paths relative to the workspace. */
  acceptedEdits: Edit[] | undefined;
}

export function materialize(task: Task): string {
  const workspace = mkdtempSync(join(tmpdir(), `fcx-train-${task.id}-`));
  for (const [path, content] of Object.entries(task.files)) {
    mkdirSync(dirname(join(workspace, path)), { recursive: true });
    writeFileSync(join(workspace, path), content);
  }
  return workspace;
}

/** Runs the real fix command on one task with the given model and grades it like evals/run.ts. */
export async function runTask(
  task: Task,
  inner: Pick<ModelHost, "generateObject">,
): Promise<TaskOutcome> {
  const workspace = materialize(task);
  const { model, calls } = recordingModel(inner);
  const undoRoot = join(workspace, ".undo");
  const logsDir = join(workspace, ".logs");
  const targetRel = task.target.split(":")[0] as string;
  try {
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
    const targetFile = join(workspace, targetRel);
    const checker = createTsChecker(workspace, targetFile);
    const remaining = errorsOnly(checker.diagnostics(targetFile)).length;
    checker.dispose();

    // The CLI report drops edits from its candidate list, so the verified edits come from report.edits.
    const accepted = report.candidates.find((c) => c.pass);
    const acceptedEdits: Edit[] | undefined =
      report.status === "applied" ? report.edits : undefined;
    let acceptedModelCallIndex: number | undefined;
    if (accepted?.source === "model" && acceptedEdits) {
      // The first successful model call whose edits equal the verified edits (search and replace only).
      const want = JSON.stringify(acceptedEdits.map(sr));
      const idx = calls.findIndex((c) => JSON.stringify(c.edits.map(sr)) === want);
      acceptedModelCallIndex = idx === -1 ? undefined : idx;
    }
    const pass = report.status === "applied" && remaining === 0;
    return {
      id: task.id,
      category: task.category,
      split: task.split,
      status: report.status,
      pass,
      candidateSource: accepted?.source ?? report.candidates[0]?.source,
      acceptedModelCallIndex,
      candidates: report.candidates.length,
      modelCalls: calls.length,
      totalMs: report.timings.totalMs,
      remainingErrors: remaining,
      error: report.error?.message,
      calls,
      acceptedEdits: acceptedEdits?.map((e) => ({
        file: e.file.startsWith("/") ? relative(workspace, e.file) : e.file,
        search: e.search,
        replace: e.replace,
      })),
    };
  } catch (error) {
    return {
      id: task.id,
      category: task.category,
      split: task.split,
      status: "error",
      pass: false,
      candidateSource: undefined,
      acceptedModelCallIndex: undefined,
      candidates: 0,
      modelCalls: calls.length,
      totalMs: 0,
      remainingErrors: -1,
      error: error instanceof Error ? error.message : String(error),
      calls,
      acceptedEdits: undefined,
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** Compares edits by search and replace only. The engine may normalize the file path of an edit. */
function sr(e: Edit): { search: string; replace: string } {
  return { search: e.search, replace: e.replace };
}

/**
 * Returns the exact prompt the recipe sends on its first model candidate, for a task the compiler can fix.
 * The compiler quick fix is disabled through a checker proxy (its code-fix call throws, and compilerFix treats
 * that as "no fix"), so the engine goes to the model path. The model call is a capture-only stub that throws, so
 * nothing is generated. The prompt does not depend on the compiler's result.
 */
export async function capturePrompt(task: Task): Promise<string | undefined> {
  const workspace = materialize(task);
  try {
    const targetRel = task.target.split(":")[0] as string;
    const line = Number.parseInt(task.target.split(":")[1] ?? "1", 10);
    const targetFile = join(workspace, targetRel);
    const real = createTsChecker(workspace, targetFile);
    const service = new Proxy(real.service, {
      get(t, p) {
        if (p === "getCodeFixesAtPosition") {
          return () => {
            throw new Error("compiler quick fix disabled for prompt capture");
          };
        }
        const v = Reflect.get(t, p, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const checker = new Proxy(real, {
      get(t, p) {
        if (p === "service") return service;
        const v = Reflect.get(t, p, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const prompts: string[] = [];
    const stub = {
      generateObject: async (req: { prompt: string }) => {
        prompts.push(req.prompt);
        throw new Error("capture-only stub");
      },
    };
    await runFixDiagnostic({
      model: stub as never,
      checker,
      workspace,
      file: targetFile,
      line,
      maxCandidates: 1,
      instructions: "",
    });
    real.dispose();
    return prompts[0];
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

export function loadTasks(splitDir: string): Task[] {
  return readdirSync(splitDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(splitDir, f), "utf-8")) as Task);
}

export function tasksRoot(): string {
  return resolve(dirname(new URL(import.meta.url).pathname), "..", "tasks");
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
