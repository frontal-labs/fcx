import { basename } from "node:path";
/**
 * fix-test: repairs a failing unit test by editing the code under test (or the test itself).
 *
 * Input: a test file, the test's name, and optionally the first failure output from the test runner.
 * Context: the test body (read from the file), and a retrieval bundle with the test file as the target and the
 * test body as the query, so the function under test and its callees are ranked in.
 * Output: { edits: Edit[] }, like fix-diagnostic. Edits may touch only files in the bundle's allow-list.
 * Layers: constrain, anchor, ground (TypeScript identifiers), verify (type check).
 *
 * Verifies: each edit applies exactly once; every identifier in the changed lines resolves; no candidate file gains a
 * type error that it did not have before.
 * Does NOT verify: that the test passes. No test executor exists in @fcx/verify, so the test is never run. A candidate
 * that type-checks can still fail the test, and it is reported as verified. The result says so in `verification`.
 * It also does not run linked tests, and it does not run the test runner to produce `failureOutput`; the caller
 * must supply that text, or the prompt says it is missing.
 */
import { type Edit, resolveInWorkspace } from "@fcx/apply";
import type { LayerOutcome } from "@fcx/defense";
import type { ModelHost } from "@fcx/model";
import { retrieve } from "@fcx/retrieve";
import { type Checker, createTsChecker, errorsOnly } from "@fcx/verify";
import * as z from "zod";
import { groundLayer, typeCheckLayer } from "../checks.js";
import {
  RecipeInputError,
  absoluteIn,
  escapeRegExp,
  findLine,
  lineAt,
  lineOffset,
  linesOf,
  matchingBrace,
  numberedRange,
  readText,
  relativeTo,
  renderBlocks,
  trimLines,
} from "../context.js";
import {
  CANDIDATE_TEMPERATURES,
  type CandidateReport,
  type LayerEvent,
  type RecipeDefinition,
  type VerificationScope,
  editsSchema,
  requireWork,
  runRecipeEngine,
} from "../engine.js";
import { FIX_TEST_SYSTEM } from "../prompts.js";

/**
 * The model names line ranges and the replacement text, instead of search strings. Bounds are checked in code, since
 * the grammar builder rejects min/max keywords. A search string has to match the
 * file character for character, and models get that wrong; a line range is checked against the numbered file.
 */
export const FixTestSchema = z.object({
  fixes: z.array(
    z.object({
      file: z.string(),
      startLine: z.number().int(),
      endLine: z.number().int(),
      replacement: z.string(),
    }),
  ),
});
export type FixTestOutput = z.infer<typeof FixTestSchema>;

export const FIX_TEST_SCOPE: VerificationScope = {
  ran: ["edit-apply", "ts-ground", "ts-type-check"],
  notRun: ["test-run: no test executor in @fcx/verify"],
};

export interface FixTestOptions {
  model: Pick<ModelHost, "generateObject">;
  workspace: string;
  /** The test file, workspace-relative or absolute. */
  testFile: string;
  /** The name passed to it() or test(). */
  testName: string;
  /** The first failure output from the test runner, when the caller has one. */
  failureOutput?: string;
  /** Index database used by retrieval. Created when missing. */
  indexPath: string;
  maxCandidates: number;
  contextBudgetTokens?: number;
  onLayer?: (event: LayerEvent) => void;
  /** The project instruction block (plan §12.2). Added to the user part of every candidate prompt. See src/instructions.ts. */
  instructions?: string;
}

export type FixTestResult =
  | {
      status: "verified";
      edits: Edit[];
      candidates: CandidateReport[];
      ms: number;
      instructionsTruncated: boolean;
      verification: VerificationScope;
    }
  | {
      status: "abstained";
      lastError: string;
      /** The last candidate that parsed, shown as "not verified". It is never applied automatically. */
      bestCandidate?: Edit[];
      candidates: CandidateReport[];
      ms: number;
      instructionsTruncated: boolean;
      verification: VerificationScope;
    };

const FAILURE_LINES = 40;
const BODY_LINES = 80;

/** Runs the fix-test recipe. Throws RecipeInputError when the test cannot be found. */
export async function runFixTest(options: FixTestOptions): Promise<FixTestResult> {
  const t0 = performance.now();
  const workspace = options.workspace;
  const testPath = absoluteIn(workspace, options.testFile);
  const source = readText(testPath);
  const testRel = relativeTo(workspace, testPath);

  const pattern = new RegExp(
    `\\b(?:it|test)(?:\\.only|\\.skip)?\\(\\s*(["'\`])${escapeRegExp(options.testName)}\\1`,
  );
  const line = findLine(source, pattern);
  if (line === undefined) {
    throw new RecipeInputError(`no test named "${options.testName}" in ${testRel}`);
  }
  const close = matchingBrace(source, lineOffset(source, line));
  const endLine = close === -1 ? line : lineAt(source, close);
  const body = linesOf(source, line, endLine);

  const failure = options.failureOutput?.trim()
    ? trimLines(options.failureOutput.trim(), FAILURE_LINES)
    : undefined;
  const bundle = await retrieve(
    {
      workspace,
      file: testPath,
      line,
      selection: body,
      errorText: failure,
      text: `fix failing test ${options.testName}`,
    },
    { dbPath: options.indexPath, contextBudgetTokens: options.contextBudgetTokens },
  );

  const allowed = [...new Set(bundle.allowLists.paths.map((p) => absoluteIn(workspace, p)))];
  if (!allowed.includes(testPath)) allowed.push(testPath);
  const related = bundle.blocks.filter(
    (b) =>
      b.why !== "error text" && relativeTo(workspace, absoluteIn(workspace, b.file)) !== testRel,
  );

  const checker = createTsChecker(workspace, testPath);
  try {
    const recipe: RecipeDefinition<FixTestOutput> = {
      schema: FixTestSchema,
      temperatures: CANDIDATE_TEMPERATURES,
      prompt: (feedback) => ({
        system: FIX_TEST_SYSTEM,
        user: [
          `Allowed files: ${allowed.map((f) => relativeTo(workspace, f)).join(", ")}`,
          `The failing test is ${testRel}. Code under test is in the other allowed files; fix the code the test calls, not the test file, unless the test itself is wrong.`,
          `Failing test: "${options.testName}" at ${testRel}:${line}`,
          failure ? `First failure output:\n${failure}` : "First failure output: (not available)",
          "",
          "Test body:",
          numberedRange(source, line, endLine),
          "",
          "Related code (the function under test and its callees):",
          renderBlocks(related),
          ...(feedback ? ["", `Your previous attempt was rejected: ${feedback}`] : []),
        ].join("\n"),
      }),
      toEdits: (output) => fixesToEdits(output, workspace, allowed),
      layers: [
        { name: "constrain" },
        { name: "anchor" },
        { name: "ground", check: ({ texts, original }) => groundLayer(checker, texts, original) },
        {
          name: "verify",
          check: ({ texts, original }) =>
            fixTestVerify({ checker, workspace, texts, original, testPath }),
        },
      ],
    };

    const result = requireWork(
      await runRecipeEngine({
        recipe,
        model: options.model,
        workspace,
        allowedFiles: allowed,
        primaryFile: testPath,
        maxCandidates: options.maxCandidates,
        onLayer: options.onLayer,
        instructions: options.instructions,
      }),
    );
    const ms = Math.round(performance.now() - t0);
    if (result.status === "verified") {
      return {
        status: "verified",
        edits: result.edits,
        candidates: result.candidates,
        ms,
        instructionsTruncated: result.instructionsTruncated,
        verification: FIX_TEST_SCOPE,
      };
    }
    return {
      status: "abstained",
      lastError: result.lastError,
      bestCandidate: result.bestCandidate,
      candidates: result.candidates,
      ms,
      instructionsTruncated: result.instructionsTruncated,
      verification: FIX_TEST_SCOPE,
    };
  } finally {
    checker.dispose();
  }
}

/**
 * The verify layer for fix-test. The shared type-check layer only refuses new errors. A fix-test edit has to leave the
 * test file with no type errors at all, because that is what the fix is for, so an edit that leaves the reported
 * error in place is rejected here.
 */
export function fixTestVerify(options: {
  checker: Checker;
  workspace: string;
  texts: ReadonlyMap<string, string>;
  original: (path: string) => string | undefined;
  testPath: string;
}): LayerOutcome {
  const t0 = performance.now();
  const base = typeCheckLayer(options);
  if (!base.pass) return base;
  const left = errorsOnly(options.checker.diagnostics(options.testPath, new Map(options.texts)));
  if (left.length === 0) return base;
  const first = left[0];
  if (first === undefined) return base;
  return {
    layer: "verify",
    pass: false,
    ms: Math.round(performance.now() - t0),
    reasonCode: "TARGET_NOT_FIXED",
    feedback: `The test file still has a type error at line ${first.line}: TS${first.code} ${first.message}. Fix every error in the file.`,
  };
}

/**
 * Writes the model's line-range fixes into each file. The file is the allowed file the fix names, or the one with the
 * same name, or the only allowed file. Each file becomes one edit that replaces its whole text, so the anchor layer
 * sees the complete new text. A fix outside the file's lines throws, which reports it as an invalid candidate.
 */
export function fixesToEdits(
  output: FixTestOutput,
  workspace: string,
  allowed: readonly string[],
): Edit[] {
  if (output.fixes.length === 0 || output.fixes.length > 4) {
    throw new Error("a candidate must give between one and four fixes");
  }
  const byFile = new Map<string, { startLine: number; endLine: number; replacement: string }[]>();
  for (const fix of output.fixes) {
    const target = resolveFixFile(fix.file, workspace, allowed);
    byFile.set(target, [...(byFile.get(target) ?? []), fix]);
  }
  const edits: Edit[] = [];
  for (const [abs, fixes] of byFile) {
    const original = readText(abs);
    const lines = original.split("\n");
    const rel = relativeTo(workspace, abs);
    const ordered = [...fixes].sort((a, b) => b.startLine - a.startLine);
    let previousStart = Number.POSITIVE_INFINITY;
    for (const fix of ordered) {
      if (fix.endLine < fix.startLine || fix.endLine > lines.length) {
        throw new Error(
          `lines ${fix.startLine}-${fix.endLine} are outside ${rel}, which has ${lines.length} lines`,
        );
      }
      if (fix.endLine >= previousStart) {
        throw new Error(`two fixes in ${rel} overlap at line ${fix.startLine}`);
      }
      previousStart = fix.startLine;
      const replaced = fix.replacement === "" ? [] : fix.replacement.split("\n");
      lines.splice(fix.startLine - 1, fix.endLine - fix.startLine + 1, ...replaced);
    }
    const before = braceBalance(original);
    const after = braceBalance(lines.join("\n"));
    if (before !== after) {
      throw new Error(
        `the fix to ${rel} changes the number of { and } (${before - after} unbalanced); keep every brace the replaced lines had`,
      );
    }
    edits.push({ file: rel, search: original, replace: lines.join("\n") });
  }
  return edits;
}

/** The allowed file a fix names: the same path, else the allowed file with the same name, else the only one. */
function resolveFixFile(file: string, workspace: string, allowed: readonly string[]): string {
  const direct = (() => {
    try {
      return resolveInWorkspace(workspace, file);
    } catch {
      return undefined;
    }
  })();
  if (direct !== undefined && allowed.includes(direct)) return direct;
  const name = basename(file);
  const sameName = allowed.filter((path) => basename(path) === name);
  if (sameName.length === 1 && sameName[0] !== undefined) return sameName[0];
  if (allowed.length === 1 && allowed[0] !== undefined) return allowed[0];
  throw new Error(`"${file}" is not one of the allowed files`);
}

/** Opening braces minus closing braces in `text`. Equal values before and after a fix mean no block was cut or opened. */
export function braceBalance(text: string): number {
  let balance = 0;
  for (const ch of text) {
    if (ch === "{") balance++;
    else if (ch === "}") balance--;
  }
  return balance;
}
