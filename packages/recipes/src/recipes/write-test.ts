/**
 * write-test: writes a new test file for one symbol.
 *
 * Input: a source file and the symbol's name.
 * Context: the symbol (retrieval with the file as the target and the name as the symbol), plus the blocks retrieval
 * ranks around it (sibling examples, dependencies). The allow-lists from retrieval (importable packages and
 * symbols in scope) are shown to the model.
 * Output: { file, imports: string[], testCode }. The engine turns this into a single create-file edit.
 * Layers: constrain (the new file is new, under tests/ or __tests__/, and every import resolves to a file in the
 * workspace, a declared package, a node: builtin, or a symbol in scope), anchor (creation), ground (TypeScript
 * identifiers), verify (the new file has no type errors).
 *
 * Verifies: the path rules above; the imports resolve; the file type-checks in memory.
 * Does NOT verify: that the test runs or passes, that the test asserts anything useful, or that `imports` lists exactly
 * the modules `testCode` imports (only that each listed import resolves). Its style is only as good as the blocks
 * retrieval returned; no separate sibling test file is read.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type Edit, isInside, resolveInWorkspace } from "@fcx/apply";
import type { LayerOutcome } from "@fcx/defense";
import type { ModelHost } from "@fcx/model";
import { type AllowLists, retrieve } from "@fcx/retrieve";
import { createTsChecker } from "@fcx/verify";
import * as z from "zod";
import { groundLayer, typeCheckLayer } from "../checks.js";
import {
  RecipeInputError,
  absoluteIn,
  isFile,
  readText,
  relativeTo,
  renderBlocks,
  targetBlock,
} from "../context.js";
import {
  CANDIDATE_TEMPERATURES,
  type CandidateReport,
  type LayerEvent,
  type RecipeDefinition,
  type VerificationScope,
  requireWork,
  runRecipeEngine,
} from "../engine.js";
import { WRITE_TEST_SYSTEM } from "../prompts.js";

export const WriteTestSchema = z.object({
  file: z.string().min(1),
  imports: z.array(z.string()),
  testCode: z.string().min(1),
});
export type WriteTestOutput = z.infer<typeof WriteTestSchema>;

export const WRITE_TEST_SCOPE: VerificationScope = {
  ran: ["path-rules", "import-resolution", "edit-apply", "ts-ground", "ts-type-check"],
  notRun: ["test-run: no test executor in @fcx/verify", "assertion quality"],
};

export interface WriteTestOptions {
  model: Pick<ModelHost, "generateObject">;
  workspace: string;
  /** The file that declares the symbol, workspace-relative or absolute. */
  file: string;
  /** The symbol's name. */
  symbol: string;
  /** Index database used by retrieval. Created when missing. */
  indexPath: string;
  maxCandidates: number;
  contextBudgetTokens?: number;
  onLayer?: (event: LayerEvent) => void;
  /** The project instruction block (plan §12.2). Added to the user part of every candidate prompt. See src/instructions.ts. */
  instructions?: string;
}

export type WriteTestResult =
  | {
      status: "verified";
      file: string;
      imports: string[];
      testCode: string;
      candidates: CandidateReport[];
      ms: number;
      instructionsTruncated: boolean;
      verification: VerificationScope;
    }
  | {
      status: "abstained";
      lastError: string;
      bestCandidate?: Edit[];
      candidates: CandidateReport[];
      ms: number;
      instructionsTruncated: boolean;
      verification: VerificationScope;
    };

const TEST_DIR = /(^|\/)(tests|__tests__)\//;

/** Runs the write-test recipe. Throws RecipeInputError when the symbol cannot be found. */
export async function runWriteTest(options: WriteTestOptions): Promise<WriteTestResult> {
  const t0 = performance.now();
  const workspace = options.workspace;
  const sourcePath = absoluteIn(workspace, options.file);
  readText(sourcePath);

  const bundle = await retrieve(
    { workspace, file: sourcePath, symbol: options.symbol },
    { dbPath: options.indexPath, contextBudgetTokens: options.contextBudgetTokens },
  );
  const target = targetBlock(bundle);
  if (!target) {
    throw new RecipeInputError(
      `no symbol "${options.symbol}" in ${relativeTo(workspace, sourcePath)}`,
    );
  }
  const allow = bundle.allowLists;
  const context = bundle.blocks.filter((b) => b !== target);

  const checker = createTsChecker(workspace, sourcePath);
  try {
    const recipe: RecipeDefinition<WriteTestOutput> = {
      schema: WriteTestSchema,
      temperatures: CANDIDATE_TEMPERATURES,
      prompt: (feedback) => ({
        system: WRITE_TEST_SYSTEM,
        user: [
          `Symbol under test: ${options.symbol} in ${relativeTo(workspace, sourcePath)}`,
          "",
          "Symbol:",
          target.text,
          "",
          "Related code:",
          renderBlocks(context),
          "",
          `Importable packages: ${allow.importablePackages.join(", ") || "(none)"}`,
          `Symbols in scope: ${allow.symbolsInScope.join(", ") || "(none)"}`,
          "The new file must be under a tests/ or __tests__/ directory and must not already exist.",
          ...(feedback ? ["", `Your previous attempt was rejected: ${feedback}`] : []),
        ].join("\n"),
      }),
      toEdits: (output) => [{ file: output.file, search: "", replace: output.testCode }],
      layers: [
        {
          name: "constrain",
          check: ({ output }) =>
            output
              ? checkNewTest(output, workspace, allow)
              : { layer: "constrain", pass: true, ms: 0 },
        },
        { name: "anchor" },
        { name: "ground", check: ({ texts, original }) => groundLayer(checker, texts, original) },
        {
          name: "verify",
          check: ({ texts, original }) => typeCheckLayer({ checker, workspace, texts, original }),
        },
      ],
    };

    const result = requireWork(
      await runRecipeEngine({
        recipe,
        model: options.model,
        workspace,
        allowedFiles: [],
        primaryFile: sourcePath,
        maxCandidates: options.maxCandidates,
        onLayer: options.onLayer,
        instructions: options.instructions,
      }),
    );
    const ms = Math.round(performance.now() - t0);
    if (result.status === "verified") {
      const output = result.output;
      if (!output) throw new Error("write-test verified without a model output");
      return {
        status: "verified",
        file: output.file,
        imports: output.imports,
        testCode: output.testCode,
        candidates: result.candidates,
        ms,
        instructionsTruncated: result.instructionsTruncated,
        verification: WRITE_TEST_SCOPE,
      };
    }
    return {
      status: "abstained",
      lastError: result.lastError,
      bestCandidate: result.bestCandidate,
      candidates: result.candidates,
      ms,
      instructionsTruncated: result.instructionsTruncated,
      verification: WRITE_TEST_SCOPE,
    };
  } finally {
    checker.dispose();
  }
}

/** Constrain for write-test: the path must be a new test file, and every import must resolve. */
export function checkNewTest(
  output: WriteTestOutput,
  workspace: string,
  allow: AllowLists,
): LayerOutcome {
  const t0 = performance.now();
  const fail = (reasonCode: string, feedback: string): LayerOutcome => ({
    layer: "constrain",
    pass: false,
    ms: Math.round(performance.now() - t0),
    reasonCode,
    feedback,
  });
  let abs: string;
  try {
    abs = resolveInWorkspace(workspace, output.file);
  } catch {
    return fail("PATH_OUTSIDE_WORKSPACE", `File "${output.file}" is outside the workspace.`);
  }
  const rel = relativeTo(workspace, abs);
  if (!TEST_DIR.test(rel)) {
    return fail(
      "TEST_PATH_OUTSIDE_TESTS",
      `The test file must be under a tests/ or __tests__/ directory, not "${rel}".`,
    );
  }
  if (existsSync(abs)) {
    return fail("TEST_PATH_NOT_NEW", `${rel} already exists. Choose a new file name.`);
  }
  for (const spec of output.imports) {
    if (!importResolves(spec, dirname(abs), workspace, allow)) {
      return fail(
        "IMPORT_NOT_RESOLVED",
        `Import "${spec}" does not resolve to a file in the project, a declared package, or a symbol in scope.`,
      );
    }
  }
  return { layer: "constrain", pass: true, ms: Math.round(performance.now() - t0) };
}

function importResolves(
  spec: string,
  fromDir: string,
  workspace: string,
  allow: AllowLists,
): boolean {
  if (spec.startsWith("node:")) return true;
  if (spec.startsWith(".")) {
    const base = resolve(fromDir, spec).replace(/\.(?:m|c)?js$/, "");
    return [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.mjs`,
      `${base}.js`,
      join(base, "index.ts"),
      join(base, "index.js"),
    ].some((candidate) => isFile(candidate) && isInside(workspace, candidate));
  }
  if (isAbsolute(spec)) return false;
  const pkg = spec.startsWith("@")
    ? spec.split("/").slice(0, 2).join("/")
    : (spec.split("/")[0] ?? spec);
  if (allow.importablePackages.includes(pkg)) return true;
  return allow.symbolsInScope.some(
    (qualified) => qualified === spec || qualified.endsWith(`.${spec}`),
  );
}
