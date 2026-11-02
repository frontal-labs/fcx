/**
 * Runs the recipe eval tasks (evals/tasks/ts/<recipe>-local/*.json) against the real local model.
 *
 * Usage: bun evals/run-recipes.ts [--recipe <id>] [--filter <substring>] [--out <file>]
 *
 * For each task: materialize the inline TypeScript project in a temp directory, call the recipe's runner directly
 * with the real GgmlNodeModelHost and the CLI's candidate budget, apply the returned edits (or write the new file),
 * then check the task's criterion with the TypeScript compiler. Tasks run one at a time, because each one loads
 * the model. The report is written to evals/reports/recipes-<date>.json.
 *
 * Criteria (see evals/generate-recipe-tasks.py for the task data):
 * - add-types: every declaration named by `symbol` has an explicit type (not any), and the file type-checks.
 * - docstring: a non-empty JSDoc block sits above the declaration named by `name`, and the file type-checks.
 * - implement: the stub's error text is gone, and the file type-checks.
 * - refactor-small: the file type-checks, and the instruction's visible effect (present/absent strings) holds.
 * - rename-extract: the new name is a word in the file, the old name is not, and the file type-checks.
 * - write-test: a new file under tests/ or __tests__/ contains the symbol and type-checks.
 * - fix-test: the test file type-checks after the fix (type-only; no test runner exists). The failure output
 *   given to the recipe is the real type-check output of the test file before the run.
 * - explain: pass = answered with no dropped claim. The cite rate is kept claims over proposed claims.
 * - commit-message: pass = the message follows the rules below. Checked on the final message, not on the engine's
 *   own layers.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { candidateBudget } from "../cli/src/lib/runtime.ts";
import type { Edit } from "../packages/apply/src/index.ts";
import { applyEditsToText } from "../packages/apply/src/index.ts";
import { GgmlNodeModelHost } from "../packages/model/src/index.ts";
import {
  COMMIT_TYPES,
  RecipeInputError,
  runAddTypes,
  runCommitMessage,
  runDocstring,
  runExplain,
  runFixTest,
  runImplement,
  runRefactorSmall,
  runRenameExtract,
  runWriteTest,
} from "../packages/recipes/src/index.ts";
import { createTsChecker, errorsOnly } from "../packages/verify/src/index.ts";

type Recipe =
  | "add-types"
  | "docstring"
  | "implement"
  | "refactor-small"
  | "rename-extract"
  | "write-test"
  | "fix-test"
  | "explain"
  | "commit-message";

interface Task {
  id: string;
  recipe: Recipe;
  shape: string;
  files: Record<string, string>;
  before?: Record<string, string>;
  input: Record<string, unknown>;
  check: Record<string, unknown>;
}

interface Outcome {
  id: string;
  recipe: Recipe;
  shape: string;
  status: string;
  pass: boolean;
  /** The first failure reason, or "" when the task passed. Used for the per-recipe failure counts. */
  reason: string;
  detail?: string;
  totalMs: number;
  candidates: number;
  acceptedSource?: string;
  firstCandidatePass?: boolean;
  /** Recipe-specific measurements (explain: claim counts; commit-message: per-rule results). */
  metrics?: Record<string, unknown>;
}

const RECIPES: Recipe[] = [
  "add-types",
  "docstring",
  "implement",
  "refactor-small",
  "rename-extract",
  "write-test",
  "fix-test",
  "explain",
  "commit-message",
];

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const filter = flag("--filter") ?? "";
const onlyRecipe = flag("--recipe");
const here = dirname(new URL(import.meta.url).pathname);
const tasksRoot = resolve(here, "tasks", "ts");
const today = new Date().toISOString().slice(0, 10);
const outFile = flag("--out") ?? join(resolve(here, "reports"), `recipes-${today}.json`);

const model = new GgmlNodeModelHost({});
const maxCandidates = candidateBudget({ maxCandidates: "auto" } as never);
const outcomes: Outcome[] = [];

function loadTasks(recipe: Recipe): Task[] {
  const dir = join(tasksRoot, `${recipe}-local`);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f.includes(filter))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as Task);
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf-8");
}

/** Applies search/replace edits, grouped by file. Throws on an anchor that is missing or not unique. */
function applyEdits(root: string, edits: Edit[]): void {
  const byFile = new Map<string, Edit[]>();
  for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
  for (const [file, list] of byFile) {
    const path = join(root, file);
    writeFileSync(path, applyEditsToText(readFileSync(path, "utf-8"), list));
  }
}

/** Type errors in one file, as "line:col TSnnnn message" strings. Uses the same checker the recipes use. */
function typeErrors(root: string, file: string): string[] {
  const abs = join(root, file);
  const checker = createTsChecker(root, abs);
  try {
    return errorsOnly(checker.diagnostics(abs)).map(
      (d) => `${d.line}:${d.column} TS${d.code} ${d.message}`,
    );
  } finally {
    checker.dispose();
  }
}

function parse(text: string, file: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Every declaration named `name` (variable, parameter, property, function, method), with whether it is typed. */
function declarationsNamed(
  text: string,
  name: string,
): { typed: boolean; any: boolean; kind: string }[] {
  const sf = parse(text, "check.ts");
  const found: { typed: boolean; any: boolean; kind: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found.push({
        typed: node.type !== undefined,
        any: node.type?.kind === ts.SyntaxKind.AnyKeyword,
        kind: ts.SyntaxKind[node.kind],
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** The JSDoc text directly above the declaration named `name`, or undefined when there is none. */
function docAbove(text: string, name: string): string | undefined {
  const sf = parse(text, "check.ts");
  let result: string | undefined;
  const visit = (node: ts.Node): void => {
    const named =
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isVariableDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === name;
    if (named && result === undefined) {
      let stmt: ts.Node = node;
      if (ts.isVariableDeclaration(node)) {
        stmt = node.parent.parent;
      }
      const leading = text.slice(stmt.getFullStart(), stmt.getStart(sf));
      const match = /\/\*\*([\s\S]*?)\*\/\s*$/.exec(leading);
      result = match ? match[1] : "";
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return result === undefined || result.trim() === "" ? undefined : result;
}

function wordPresent(text: string, word: string): boolean {
  return new RegExp(`\\b${word.replace(/[$]/g, "\\$")}\\b`).test(text);
}

function gitIn(cwd: string, gitArgs: string[]): void {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=fcx-eval",
      "-c",
      "user.email=eval@localhost",
      "-c",
      "commit.gpgsign=false",
      ...gitArgs,
    ],
    { cwd, stdio: ["ignore", "ignore", "pipe"] },
  );
}

/** Commit-message rules, checked on the final message text. */
function commitRules(
  message: { type: string; scope?: string; subject: string },
  text: string,
): Record<string, boolean> {
  const lines = text.split("\n");
  const header = lines[0] ?? "";
  const headerRe =
    /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9][a-z0-9._/-]*\))?: (.+)$/;
  const match = headerRe.exec(header);
  return {
    type: (COMMIT_TYPES as readonly string[]).includes(message.type),
    header: match !== null && match[3] === message.subject,
    "subject-length": message.subject.length <= 72,
    "no-period": !message.subject.endsWith("."),
    "single-line-subject":
      !/[\r\n]/.test(message.subject) && message.subject.trim() === message.subject,
    "blank-line-before-body": lines.length < 2 || lines[1] === "",
  };
}

async function runTask(task: Task): Promise<Outcome> {
  const started = performance.now();
  const workspace = mkdtempSync(join(tmpdir(), `fcx-recipe-${task.id}-`));
  const indexDir = mkdtempSync(join(tmpdir(), "fcx-recipe-index-"));
  const indexPath = join(indexDir, "index.db");
  const base = {
    id: task.id,
    recipe: task.recipe,
    shape: task.shape,
    candidates: 0,
  };
  const fail = (
    status: string,
    reason: string,
    detail?: string,
    extra?: Partial<Outcome>,
  ): Outcome => ({
    ...base,
    status,
    pass: false,
    reason,
    detail,
    totalMs: Math.round(performance.now() - started),
    ...extra,
  });
  try {
    if (task.recipe === "commit-message") {
      // The seed commit holds the before state. The after state is staged, as the recipe expects.
      writeFiles(workspace, task.before ?? {});
      gitIn(workspace, ["init", "-q"]);
      gitIn(workspace, ["add", "-A"]);
      gitIn(workspace, ["commit", "-q", "-m", "chore: seed"]);
      for (const path of Object.keys(task.before ?? {})) {
        if (!(path in task.files)) rmSync(join(workspace, path));
      }
      writeFiles(workspace, task.files);
      gitIn(workspace, ["add", "-A"]);
    } else {
      writeFiles(workspace, task.files);
    }

    const file = typeof task.input.file === "string" ? task.input.file : "";

    switch (task.recipe) {
      case "add-types": {
        const r = await runAddTypes({
          model,
          workspace,
          file,
          symbol: task.input.symbol as string,
          maxCandidates,
        });
        const candidates = "candidates" in r ? r.candidates : [];
        const meta = {
          candidates: candidates.length,
          firstCandidatePass: candidates[0]?.pass,
          acceptedSource: candidates.find((c) => c.pass)?.source,
        };
        if (r.status !== "verified") {
          return fail(
            r.status,
            `recipe:${r.status}`,
            "lastError" in r ? r.lastError : undefined,
            meta,
          );
        }
        applyEdits(workspace, r.edits);
        const symbol = task.check.symbol as string;
        const decls = declarationsNamed(read(workspace, file), symbol);
        const untyped = decls.filter((d) => !d.typed).length;
        const anyTyped = decls.some((d) => d.any);
        const errs = typeErrors(workspace, task.check.typeCheckFile as string);
        const reasons = [
          decls.length === 0 ? "criterion:no-declaration" : "",
          untyped > 0 ? "criterion:still-untyped" : "",
          anyTyped ? "criterion:annotated-any" : "",
          errs.length > 0 ? "criterion:type-errors" : "",
        ].filter(Boolean);
        if (reasons.length > 0) {
          return fail(
            r.status,
            reasons[0] as string,
            errs.slice(0, 2).join(" | ") || undefined,
            meta,
          );
        }
        return {
          ...base,
          status: r.status,
          pass: true,
          reason: "",
          totalMs: Math.round(performance.now() - started),
          ...meta,
        };
      }

      case "docstring": {
        const r = await runDocstring({
          model,
          workspace,
          file,
          line: task.input.line as number,
          maxCandidates,
        });
        const candidates = "candidates" in r ? r.candidates : [];
        const meta = {
          candidates: candidates.length,
          firstCandidatePass: candidates[0]?.pass,
          acceptedSource: candidates.find((c) => c.pass)?.source,
        };
        if (r.status !== "verified") {
          return fail(
            r.status,
            `recipe:${r.status}`,
            "lastError" in r ? r.lastError : undefined,
            meta,
          );
        }
        applyEdits(workspace, r.edits);
        const name = task.check.name as string;
        const doc = docAbove(read(workspace, file), name);
        const errs = typeErrors(workspace, task.check.typeCheckFile as string);
        if (doc === undefined) return fail(r.status, "criterion:no-jsdoc", undefined, meta);
        if (errs.length > 0) return fail(r.status, "criterion:type-errors", errs[0], meta);
        return {
          ...base,
          status: r.status,
          pass: true,
          reason: "",
          totalMs: Math.round(performance.now() - started),
          ...meta,
        };
      }

      case "implement": {
        const r = await runImplement({
          model,
          workspace,
          file,
          line: task.input.line as number,
          indexPath,
          maxCandidates,
        });
        const candidates = r.candidates;
        const meta = {
          candidates: candidates.length,
          firstCandidatePass: candidates[0]?.pass,
          acceptedSource: candidates.find((c) => c.pass)?.source,
        };
        if (r.status !== "verified") {
          return fail(r.status, `recipe:${r.status}`, r.lastError, meta);
        }
        applyEdits(workspace, r.edits);
        const text = read(workspace, file);
        const stillStub = text.includes(task.check.stubMarker as string);
        const errs = typeErrors(workspace, task.check.typeCheckFile as string);
        if (stillStub) return fail(r.status, "criterion:stub-still-throws", undefined, meta);
        if (errs.length > 0) return fail(r.status, "criterion:type-errors", errs[0], meta);
        return {
          ...base,
          status: r.status,
          pass: true,
          reason: "",
          totalMs: Math.round(performance.now() - started),
          ...meta,
        };
      }

      case "refactor-small": {
        const r = await runRefactorSmall({
          model,
          workspace,
          file,
          startLine: task.input.startLine as number,
          endLine: task.input.endLine as number,
          instruction: task.input.instruction as string,
          indexPath,
          maxCandidates,
        });
        const candidates = r.candidates;
        const meta = {
          candidates: candidates.length,
          firstCandidatePass: candidates[0]?.pass,
          acceptedSource: candidates.find((c) => c.pass)?.source,
        };
        if (r.status !== "verified") {
          return fail(r.status, `recipe:${r.status}`, r.lastError, meta);
        }
        applyEdits(workspace, r.edits);
        const text = read(workspace, file);
        const effect = task.check.effect as { absent: string[]; present: string[] };
        const missing = effect.present.filter((s) => !text.includes(s));
        const leftover = effect.absent.filter((s) => text.includes(s));
        const errs = typeErrors(workspace, task.check.typeCheckFile as string);
        if (errs.length > 0) return fail(r.status, "criterion:type-errors", errs[0], meta);
        if (leftover.length > 0)
          return fail(
            r.status,
            "criterion:effect-absent-still-present",
            leftover.join(" | "),
            meta,
          );
        if (missing.length > 0)
          return fail(r.status, "criterion:effect-present-missing", missing.join(" | "), meta);
        return {
          ...base,
          status: r.status,
          pass: true,
          reason: "",
          totalMs: Math.round(performance.now() - started),
          ...meta,
        };
      }

      case "rename-extract": {
        const r = await runRenameExtract({
          model,
          workspace,
          file,
          line: task.input.line as number,
          column: task.input.column as number,
          newName: task.input.newName as string,
          maxCandidates,
        });
        const candidates = r.candidates;
        const meta = {
          candidates: candidates.length,
          firstCandidatePass: candidates[0]?.pass,
          acceptedSource: candidates.find((c) => c.pass)?.source,
        };
        if (r.status !== "verified") {
          return fail(r.status, `recipe:${r.status}`, r.lastError, meta);
        }
        for (const f of r.files) writeFileSync(join(workspace, f.file), f.text);
        const text = read(workspace, task.check.typeCheckFile as string);
        const oldName = task.check.oldName as string;
        const newName = task.check.newName as string;
        const errs = typeErrors(workspace, task.check.typeCheckFile as string);
        if (!wordPresent(text, newName))
          return fail(r.status, "criterion:new-name-missing", undefined, meta);
        if (wordPresent(text, oldName))
          return fail(r.status, "criterion:old-name-remains", undefined, meta);
        if (errs.length > 0) return fail(r.status, "criterion:type-errors", errs[0], meta);
        return {
          ...base,
          status: r.status,
          pass: true,
          reason: "",
          totalMs: Math.round(performance.now() - started),
          ...meta,
        };
      }

      case "write-test": {
        const r = await runWriteTest({
          model,
          workspace,
          file,
          symbol: task.input.symbol as string,
          indexPath,
          maxCandidates,
        });
        const candidates = r.candidates;
        const meta = {
          candidates: candidates.length,
          firstCandidatePass: candidates[0]?.pass,
          acceptedSource: candidates.find((c) => c.pass)?.source,
        };
        if (r.status !== "verified") {
          return fail(r.status, `recipe:${r.status}`, r.lastError, meta);
        }
        const testPath = r.file;
        const under = (task.check.newTestUnder as string[]).some((d) =>
          new RegExp(`(^|/)${d}`).test(testPath),
        );
        if (!under) return fail(r.status, "criterion:not-under-tests-dir", testPath, meta);
        writeFiles(workspace, { [testPath]: r.testCode });
        const text = read(workspace, testPath);
        const symbol = task.input.symbol as string;
        if (!wordPresent(text, symbol))
          return fail(r.status, "criterion:symbol-not-in-test", undefined, meta);
        const errs = typeErrors(workspace, testPath);
        if (errs.length > 0) return fail(r.status, "criterion:type-errors", errs[0], meta);
        return {
          ...base,
          status: r.status,
          pass: true,
          reason: "",
          totalMs: Math.round(performance.now() - started),
          ...meta,
        };
      }

      case "fix-test": {
        const testFile = task.input.testFile as string;
        const baseline = typeErrors(workspace, testFile);
        if (baseline.length === 0) {
          return fail(
            "harness",
            "harness:no-baseline-error",
            "the test file type-checks before the run",
          );
        }
        // The real type-check output of the test file, as the test runner's failure text.
        const failureOutput = baseline.map((e) => `${testFile}:${e}`).join("\n");
        const r = await runFixTest({
          model,
          workspace,
          testFile,
          testName: task.input.testName as string,
          failureOutput,
          indexPath,
          maxCandidates,
        });
        const candidates = r.candidates;
        const meta = {
          candidates: candidates.length,
          firstCandidatePass: candidates[0]?.pass,
          acceptedSource: candidates.find((c) => c.pass)?.source,
        };
        if (r.status !== "verified") {
          return fail(r.status, `recipe:${r.status}`, r.lastError, meta);
        }
        applyEdits(workspace, r.edits);
        const errs = typeErrors(workspace, task.check.typeCheckFile as string);
        if (errs.length > 0) return fail(r.status, "criterion:type-errors", errs[0], meta);
        return {
          ...base,
          status: r.status,
          pass: true,
          reason: "",
          totalMs: Math.round(performance.now() - started),
          ...meta,
        };
      }

      case "explain": {
        const r = await runExplain({
          model,
          workspace,
          file,
          startLine: task.input.startLine as number,
          endLine: task.input.endLine as number,
          question: task.input.question as string | undefined,
        });
        const kept = r.answer.claims.length;
        const dropped = r.dropped.length;
        const proposed = kept + dropped;
        const metrics = { kept, dropped, proposed, attempts: r.attempts };
        const answered = r.status === "answered";
        const pass = answered && dropped === 0;
        const reason = pass ? "" : answered ? "criterion:claims-dropped" : "recipe:abstained";
        const detail =
          r.status === "abstained"
            ? r.lastError
            : dropped > 0
              ? r.dropped.map((d) => d.reasonCode).join(",")
              : undefined;
        return { ...base, status: r.status, pass, reason, detail, totalMs: r.ms, metrics };
      }

      case "commit-message": {
        const r = await runCommitMessage({ model, repo: workspace, maxCandidates });
        if (r.status === "no-changes") return fail("no-changes", "harness:no-changes");
        const candidates = r.candidates;
        const meta = {
          candidates: candidates.length,
          firstCandidatePass: candidates[0]?.pass,
          acceptedSource: candidates.find((c) => c.pass)?.source,
        };
        if (r.status !== "verified") {
          return fail(r.status, `recipe:${r.status}`, r.lastError, meta);
        }
        const rules = commitRules(r.message, r.text);
        const failed = Object.entries(rules)
          .filter(([, ok]) => !ok)
          .map(([name]) => name);
        const metrics = { rules, failedRules: failed };
        if (failed.length > 0) {
          return {
            ...base,
            ...meta,
            status: r.status,
            pass: false,
            reason: `rule:${failed[0]}`,
            detail: r.text,
            totalMs: r.ms,
            metrics,
          };
        }
        return {
          ...base,
          ...meta,
          status: r.status,
          pass: true,
          reason: "",
          totalMs: r.ms,
          metrics,
        };
      }
    }
  } catch (error) {
    if (error instanceof RecipeInputError) {
      return fail("input-error", "harness:input-error", error.message);
    }
    return fail(
      "error",
      "harness:exception",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(indexDir, { recursive: true, force: true });
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const selected = onlyRecipe ? RECIPES.filter((r) => r === onlyRecipe) : RECIPES;
try {
  for (const recipe of selected) {
    const tasks = loadTasks(recipe);
    console.log(`== ${recipe}: ${tasks.length} tasks`);
    for (const task of tasks) {
      const outcome = await runTask(task);
      outcomes.push(outcome);
      console.log(
        `${outcome.id}: ${outcome.status} pass=${outcome.pass} reason=${outcome.reason || "-"} ${outcome.totalMs}ms${outcome.detail ? ` detail=${outcome.detail.slice(0, 160).replace(/\n/g, " ")}` : ""}`,
      );
    }
  }
} finally {
  await model.shutdown();
}

const perRecipe: Record<string, unknown> = {};
for (const recipe of selected) {
  const rs = outcomes.filter((o) => o.recipe === recipe);
  if (rs.length === 0) continue;
  const passed = rs.filter((o) => o.pass).length;
  const reasons: Record<string, number> = {};
  for (const o of rs) if (!o.pass) reasons[o.reason] = (reasons[o.reason] ?? 0) + 1;
  const entry: Record<string, unknown> = {
    tasks: rs.length,
    passed,
    passRate: passed / rs.length,
    medianMs: median(rs.map((o) => o.totalMs)),
    medianCandidates: median(rs.map((o) => o.candidates)),
    firstCandidatePassed: rs.filter((o) => o.firstCandidatePass === true).length,
    failureReasons: reasons,
  };
  if (recipe === "explain") {
    const kept = rs.reduce((n, o) => n + ((o.metrics?.kept as number) ?? 0), 0);
    const proposed = rs.reduce((n, o) => n + ((o.metrics?.proposed as number) ?? 0), 0);
    entry.claimsKept = kept;
    entry.claimsProposed = proposed;
    entry.citeRate = proposed === 0 ? 0 : kept / proposed;
    entry.answered = rs.filter((o) => o.status === "answered").length;
  }
  if (recipe === "commit-message") {
    const ruleNames = [
      "type",
      "header",
      "subject-length",
      "no-period",
      "single-line-subject",
      "blank-line-before-body",
    ];
    const ruleRates: Record<string, number> = {};
    for (const name of ruleNames) {
      const ok = rs.filter(
        (o) => (o.metrics?.rules as Record<string, boolean> | undefined)?.[name] === true,
      ).length;
      ruleRates[name] = ok / rs.length;
    }
    entry.ruleRates = ruleRates;
  }
  perRecipe[recipe] = entry;
}

const summary = {
  model: "ggml/auto (qwen2.5-1.5b-instruct-q4_k_m)",
  generatedAt: new Date().toISOString(),
  candidateBudget: maxCandidates,
  synthetic: true,
  recipes: perRecipe,
  results: outcomes,
};
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\nReport: ${outFile}`);
for (const [recipe, entry] of Object.entries(perRecipe)) {
  const e = entry as { passed: number; tasks: number };
  console.log(`${recipe}: ${e.passed}/${e.tasks}`);
}
