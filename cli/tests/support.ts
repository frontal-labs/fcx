import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Env keys the CLI reads. A sandbox saves and restores them so tests never touch a real config home. */
const SANDBOX_KEYS = [
  "FRONTAL_CODE_CONFIG_HOME",
  "FRONTAL_CODE_HOME",
  "FRONTAL_CODE_CACHE_DIR",
  "FRONTAL_CODE_LOGS_DIR",
  "FRONTAL_API_KEY",
  "FRONTAL_BASE_URL",
  "RUSTY_CLAUDE_PERMISSION_MODE",
];

export const SOURCE = `export function total(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export const label: string = total([1, 2]);
`;

export const GOOD_EDIT = {
  edits: [
    {
      file: "src/a.ts",
      search: "export const label: string = total([1, 2]);",
      replace: "export const label: string = String(total([1, 2]));",
    },
  ],
};

/** Edit that introduces a new error and never fixes the original one. */
export const BREAKING_EDIT = {
  edits: [{ file: "src/a.ts", search: "total([1, 2])", replace: "totl([1, 2])" }],
};

export interface Sandbox {
  root: string;
  workspace: string;
  cache: string;
  configHome: string;
  cleanup(): void;
}

/**
 * A temp directory with a TypeScript workspace, an empty config home and a cache dir. The config and cache
 * environment variables point into it for the life of the sandbox.
 */
export function makeSandbox(prefix: string): Sandbox {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const workspace = join(root, "ws");
  const cache = join(root, "cache");
  const configHome = join(root, "config-home");
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(configHome);
  writeTsProject(workspace, SOURCE);

  const saved = Object.fromEntries(SANDBOX_KEYS.map((k) => [k, process.env[k]]));
  for (const key of SANDBOX_KEYS) Reflect.deleteProperty(process.env, key);
  process.env.FRONTAL_CODE_CONFIG_HOME = configHome;
  process.env.FRONTAL_CODE_CACHE_DIR = cache;

  return {
    root,
    workspace,
    cache,
    configHome,
    cleanup() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Writes a tsconfig and src/a.ts so the real TypeScript checker has something to verify. */
export function writeTsProject(workspace: string, source: string): void {
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
      include: ["src"],
    }),
  );
  writeFileSync(join(workspace, "src", "a.ts"), source);
}

/** A model stand-in that returns queued outputs and records every prompt it was sent. */
export function scriptedModel(outputs: unknown[]) {
  const prompts: string[] = [];
  return {
    prompts,
    generateObject: async <T>(req: { prompt: string }) => {
      prompts.push(req.prompt);
      const object = outputs.shift();
      if (object === undefined) throw new Error("scripted model ran out of outputs");
      return { object: object as T, ms: 1, raw: JSON.stringify(object) };
    },
    countTokens: (text: string) => Math.ceil(text.length / 3.5),
  };
}

/** Captures console.log output while a callback runs. */
export async function captureLog(
  run: () => Promise<number>,
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const spy = (message?: unknown) => {
    lines.push(String(message));
  };
  const original = console.log;
  console.log = spy;
  try {
    const code = await run();
    return { code, lines };
  } finally {
    console.log = original;
  }
}
