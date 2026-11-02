import type { ModelHost } from "@fcx/model";
import * as z from "zod";
import { prepareInstructions, withInstructions } from "./instructions.js";

/**
 * Intent router (plan §9.1). Maps a free-form task to one recipe, or to "unsupported" with a reason.
 * The system prompt is versioned in prompts/router.md. A test keeps ROUTER_SYSTEM identical to that file.
 * An explicit recipe id skips the model entirely.
 */

/** Version of prompts/router.md. Bump it when the prompt changes, and re-run the router evals. */
export const ROUTER_PROMPT_VERSION = 1;

/** The ten recipe ids, in the order the CLI lists them. */
export const RECIPE_IDS = [
  "fix-diagnostic",
  "fix-test",
  "write-test",
  "implement",
  "add-types",
  "docstring",
  "refactor-small",
  "rename-extract",
  "explain",
  "commit-message",
] as const;

export type RecipeId = (typeof RECIPE_IDS)[number];

/** One-line description of each recipe, as the router prompt states it. */
export const RECIPE_DESCRIPTIONS: Readonly<Record<RecipeId, string>> = {
  "fix-diagnostic": "Fix one or more compiler or type errors at a file and line.",
  "fix-test": "Fix a failing test by changing the code under test or the test itself.",
  "write-test": "Write a new unit test file for one symbol.",
  implement: "Write the body of a stub function from its signature and doc comment.",
  "add-types": "Add missing type annotations to a symbol or file (TypeScript or Python).",
  docstring: "Write a doc comment for one symbol.",
  "refactor-small": "Make a small refactor of a selected range, following an instruction.",
  "rename-extract":
    "Rename a symbol, or extract a selected range into a new named function or variable.",
  explain: "Explain a selection or answer a question about the code, citing the lines it uses.",
  "commit-message": "Write a conventional commit message for the staged changes.",
};

/** Every value the router may return from the model. */
const ROUTABLE = [...RECIPE_IDS, "unsupported"] as const;

/** The model's output. `recipe` is constrained to the enum, so anything else is a schema error. */
export const RouterSchema = z.object({
  recipe: z.enum(ROUTABLE),
  target: z.string().optional(),
  reason: z.string().optional(),
});
export type RouterOutput = z.infer<typeof RouterSchema>;

/**
 * `instructionsTruncated` is set on model results only. An explicit recipe id never calls the model, so no prompt
 * was built and nothing was cut.
 */
export type RouteResult =
  | {
      recipe: RecipeId;
      target?: string;
      source: "explicit" | "model";
      instructionsTruncated?: boolean;
    }
  | { recipe: "unsupported"; reason: string; source: "model"; instructionsTruncated: boolean };

/** The model returned output outside the schema, or an explicit recipe id is unknown. Reported, never guessed. */
export class RouterSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouterSchemaError";
  }
}

export function isRecipeId(value: string): value is RecipeId {
  return (RECIPE_IDS as readonly string[]).includes(value);
}

export interface RouteOptions {
  model: Pick<ModelHost, "generateObject">;
  /** The task as the user typed it. */
  text: string;
  /** An explicit recipe id from the CLI subcommand or ACP code action. When set, the model is not called. */
  recipe?: string;
  /** The project instruction block (plan §12.2). Added to the router prompt's task part. See src/instructions.ts. */
  instructions?: string;
}

/** Routes a task. Throws RouterSchemaError on an unknown explicit id or a model output outside the schema. */
export async function route(options: RouteOptions): Promise<RouteResult> {
  if (options.recipe !== undefined) {
    if (!isRecipeId(options.recipe)) {
      throw new RouterSchemaError(`unknown recipe id: ${options.recipe}`);
    }
    return { recipe: options.recipe, source: "explicit" };
  }
  if (options.text.trim() === "") {
    throw new Error("the task is empty");
  }

  const instructions = prepareInstructions(options.instructions);
  const result = await options.model.generateObject<unknown>({
    schema: RouterSchema,
    prompt: `${ROUTER_SYSTEM}\n\n${withInstructions(`Task: ${options.text.trim()}`, instructions.text)}`,
    temperature: 0,
    maxTokens: 256,
  });
  const parsed = RouterSchema.safeParse(result.object);
  if (!parsed.success) {
    throw new RouterSchemaError(`router output did not match the schema: ${parsed.error.message}`);
  }
  const output = parsed.data;
  if (output.recipe === "unsupported") {
    return {
      recipe: "unsupported",
      reason: output.reason ?? "fcx has no recipe for this task.",
      source: "model",
      instructionsTruncated: instructions.truncated,
    };
  }
  return {
    recipe: output.recipe,
    target: output.target,
    source: "model",
    instructionsTruncated: instructions.truncated,
  };
}

/** Router system prompt. Source: prompts/router.md (promptVersion 1). Byte-stable for the prompt cache. */
export const ROUTER_SYSTEM = `You are the intent router for fcx, a local coding agent. Your only job is to classify a task as one recipe or as "unsupported".

Recipes (id: what it does, then examples):

fix-diagnostic: Fix one or more compiler or type errors at a file and line.
Example: fix src/foo.ts:12 - resolve the reported error at line 12
Example: fix src/foo.ts - fix the type errors in this file

fix-test: Fix a failing test by changing the code under test or the test itself.
Example: fix-test TestUserLogin - make this failing test pass
Example: the parseDate test is failing, fix it

write-test: Write a new unit test file for one symbol.
Example: write-test utils.format - add tests for format
Example: write a test for parseConfig in src/config.ts

implement: Write the body of a stub function from its signature and doc comment.
Example: implement fetchUser - fill in the stub body
Example: implement src/api.ts:42 - implement the stub at line 42

add-types: Add missing type annotations to a symbol or file (TypeScript or Python).
Example: add-types utils.ts - add the missing annotations
Example: type the format function

docstring: Write a doc comment for one symbol.
Example: docstring format - document this function
Example: doc src/utils.ts:10 - document the symbol at line 10

refactor-small: Make a small refactor of a selected range, following an instruction.
Example: refactor src/foo.ts:10-20 - inline the variable
Example: refactor the selection to use an early return

rename-extract: Rename a symbol to a new name, or extract a selected range into a new named function or variable.
Example: rename fetchData to fetchUserData
Example: extract src/foo.ts:10-20 into a helper

explain: Explain a selection or answer a question about the code, citing the lines it relies on.
Example: explain src/foo.ts:10-30
Example: why does this use a mutex?

commit-message: Write a conventional commit message for the staged changes.
Example: commit message for my staged changes
Example: write the commit message

Rules:
- If the task matches one recipe, output its id. Put the file, symbol, line, or range the task names in "target", as plain text. Leave "target" out when the task names none.
- If nothing matches, output "unsupported". Put a short reason in "reason" that says what fcx can do instead.
- Commands such as undo, index, init, models, status, doctor, and acp are not recipes. Answer "unsupported" for them and say which command handles the request.
- Do not guess a recipe for a task that none of the recipes covers.

Output format: { "recipe": "<recipe id or unsupported>", "target": "<optional target>", "reason": "<only when unsupported>" }`;
