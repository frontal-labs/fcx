/**
 * create: creates a new file from a description.
 *
 * Input: a workspace-relative file path and a description of what the file should contain.
 * Output: { code }, the full file content. The engine turns this into a single create-file edit
 * (search: "", replace: code).
 * Layers: constrain (the path is inside the workspace and the file does not yet exist), anchor (creation),
 * ground (TypeScript identifiers resolve), verify (the new file type-checks).
 *
 * Verifies: the path is inside the workspace, the file is new, imports resolve, the file type-checks.
 * Does NOT verify: that the file fulfills the description, that linked tests pass, or anything by running code.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

export const CreateSchema = z.object({
  code: z.string().min(1),
});
export type CreateOutput = z.infer<typeof CreateSchema>;

export const CREATE_SCOPE: VerificationScope = {
  ran: ["path-rules", "import-resolution", "edit-apply", "ts-ground", "ts-type-check"],
  notRun: [
    "description-conformance: the code is not checked against the description",
    "execution: no code is run or tested",
  ],
};

export interface CreateOptions {
  model: Pick<ModelHost, "generateObject" | "countTokens">;
  workspace: string;
  /** The path of the new file, workspace-relative or absolute. */
  file: string;
  /** The user's description of what the file should contain. */
  description: string;
  /** Index database used by retrieval. Created when missing. */
  indexPath: string;
  maxCandidates: number;
  contextBudgetTokens?: number;
  onLayer?: (event: LayerEvent) => void;
  /** The project instruction block (plan §12.2). Added to the user part of every candidate prompt. See src/instructions.ts. */
  instructions?: string;
}

export type CreateResult =
  | {
      status: "verified";
      file: string;
      code: string;
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

export const CREATE_SYSTEM = `You are a coding agent creating a new file. Given a file path and a description, produce the full file content.

Constraints:
- Output must be valid JSON matching the schema: { "code": "..." }.
- The code must be the complete file content, including imports and all declarations.
- Only reference symbols in scope or imported in the file.
- Every import must be a module the project resolves (a relative path to a file in the workspace, a declared package, or a node: builtin).
- Do not invent file paths, symbols, or package names. Write idiomatic TypeScript.`;

/** Runs the create recipe. Throws RecipeInputError when the path is invalid. */
export async function runCreate(options: CreateOptions): Promise<CreateResult> {
  const t0 = performance.now();
  const workspace = options.workspace;
  const abs = absoluteIn(workspace, options.file);
  const rel = relativeTo(workspace, abs);

  if (existsSync(abs)) {
    throw new RecipeInputError(`file already exists: ${rel}`);
  }

  const checker = createTsChecker(workspace, abs);
  try {
    const bundle = await retrieve(
      { workspace, file: abs, symbol: "" },
      { dbPath: options.indexPath, contextBudgetTokens: options.contextBudgetTokens },
    );
    const allow = bundle.allowLists;
    const context = bundle.blocks;

    const recipe: RecipeDefinition<CreateOutput> = {
      schema: CreateSchema,
      temperatures: CANDIDATE_TEMPERATURES,
      normalize: (output) => output,
      prompt: (feedback) => ({
        system: CREATE_SYSTEM,
        user: [
          `Create file: ${rel}`,
          `Description: ${options.description}`,
          "",
          "Related code in the workspace:",
          renderBlocks(context),
          `Importable packages: ${allow.importablePackages.join(", ") || "(none)"}`,
          `Symbols in scope: ${allow.symbolsInScope.join(", ") || "(none)"}`,
          ...(feedback ? ["", `Your previous attempt was rejected: ${feedback}`] : []),
        ].join("\n"),
      }),
      toEdits: (output) => [{ file: rel, search: "", replace: output.code }],
      layers: [
        {
          name: "constrain",
          check: ({ output }) =>
            output
              ? checkNewFile(output.code, workspace, rel, allow)
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
        primaryFile: abs,
        maxCandidates: options.maxCandidates,
        countTokens: options.model.countTokens,
        onLayer: options.onLayer,
        instructions: options.instructions,
      }),
    );
    const ms = Math.round(performance.now() - t0);
    if (result.status === "verified") {
      const output = result.output;
      if (!output) throw new Error("create verified without a model output");
      return {
        status: "verified",
        file: rel,
        code: output.code,
        candidates: result.candidates,
        ms,
        instructionsTruncated: result.instructionsTruncated,
        verification: CREATE_SCOPE,
      };
    }
    return {
      status: "abstained",
      lastError: result.lastError,
      bestCandidate: result.bestCandidate,
      candidates: result.candidates,
      ms,
      instructionsTruncated: result.instructionsTruncated,
      verification: CREATE_SCOPE,
    };
  } finally {
    checker.dispose();
  }
}

/** Constrain for create: the code's imports must resolve, and the path is inside the workspace. */
function checkNewFile(
  code: string,
  workspace: string,
  rel: string,
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
  const abs = resolve(workspace, rel);
  // Imports are top-level import declarations in the code.
  const importRegex = /^\s*import\s+(?:[^'"]*from\s+)?["']([^"']+)["']/gm;
  let match: RegExpExecArray | null;
  while (true) {
    match = importRegex.exec(code);
    if (match === null) break;
    const spec = match[1];
    if (!importResolves(spec, dirname(abs), workspace, allow)) {
      return fail(
        "IMPORT_NOT_RESOLVED",
        `Import "${spec}" does not resolve to a file in the workspace, a declared package, or a symbol in scope.`,
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
  if (spec.startsWith("/") || spec.startsWith("\\")) return false;
  const pkg = spec.startsWith("@")
    ? spec.split("/").slice(0, 2).join("/")
    : (spec.split("/")[0] ?? spec);
  if (allow.importablePackages.includes(pkg)) return true;
  return allow.symbolsInScope.some(
    (qualified) => qualified === spec || qualified.endsWith(`.${spec}`),
  );
}
