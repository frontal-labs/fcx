import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RecipeEnv } from "../src/lib/recipe-runtime.js";
import type { Sandbox, scriptedModel } from "./support.js";

/** Writes files under the sandbox workspace and a tsconfig that covers `src` and `tests`. */
export function writeProject(workspace: string, files: Record<string, string>): void {
  writeFileSync(
    join(workspace, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        noEmit: true,
      },
      include: ["src", "tests"],
    }),
  );
  for (const [path, text] of Object.entries(files)) {
    const abs = join(workspace, path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, text, "utf8");
  }
}

/** A RecipeEnv over a sandbox, with a scripted model and the apply mode the test asks for. */
export function recipeEnv(
  sb: Sandbox,
  model: ReturnType<typeof scriptedModel>,
  overrides: Partial<RecipeEnv> = {},
): RecipeEnv {
  return {
    workspace: sb.workspace,
    model,
    maxCandidates: 1,
    indexPath: join(sb.cache, "index", "test.sqlite"),
    undoRoot: join(sb.cache, "undo"),
    logsDir: join(sb.cache, "logs"),
    permissionMode: "workspace-write",
    dryRun: false,
    approve: async () => false,
    ...overrides,
  };
}

/** Runs git in a directory with a fixed identity. Only ever used on temp repositories. */
export function git(dir: string, args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd: dir, encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout };
}

/** A temp git repository with one staged file, and no commits. */
export function stagedRepo(dir: string, file: string, text: string): void {
  git(dir, ["init", "-q"]);
  writeFileSync(join(dir, file), text, "utf8");
  git(dir, ["add", file]);
}
