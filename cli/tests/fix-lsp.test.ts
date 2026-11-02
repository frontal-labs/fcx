import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LspError, detectServers } from "@fcx/lsp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FixCommandOptions, runFixCommand } from "../src/commands/fix.js";
import { undoRootFor } from "../src/lib/repo.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const SOURCE = `export function total(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export const label: string = total([1, 2]);
`;

const GOOD_EDIT = {
  edits: [
    {
      file: "src/a.ts",
      search: "export const label: string = total([1, 2]);",
      replace: "export const label: string = String(total([1, 2]));",
    },
  ],
};

/** A model stand-in that returns queued outputs and records every prompt it was sent. */
function scriptedModel(outputs: unknown[]) {
  const prompts: string[] = [];
  return {
    prompts,
    generateObject: async <T>(req: { prompt: string }) => {
      prompts.push(req.prompt);
      const object = outputs.shift();
      if (object === undefined) throw new Error("scripted model ran out of outputs");
      return { object: object as T, ms: 1, raw: JSON.stringify(object) };
    },
  };
}

describe("fcx fix with a language server for context", () => {
  let root: string;
  let workspace: string;
  let cache: string;
  let options: Omit<FixCommandOptions, "model" | "target">;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fcx-fix-lsp-"));
    workspace = join(root, "ws");
    cache = join(root, "cache");
    mkdirSync(join(workspace, "src"), { recursive: true });
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
    writeFileSync(join(workspace, "src", "a.ts"), SOURCE);
    options = {
      workspace,
      permissionMode: "workspace-write",
      dryRun: false,
      maxCandidates: 4,
      approve: async () => false,
      undoRoot: undoRootFor(cache, workspace),
      logsDir: join(cache, "logs"),
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const read = () => readFileSync(join(workspace, "src", "a.ts"), "utf-8");

  it("(a) an untrusted workspace never runs its own server binary, and the context comes from the checker", async () => {
    // A fake server that would leave a marker file if it ever ran.
    const marker = join(root, "fake-server-ran");
    const binDir = join(workspace, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const fake = join(binDir, "typescript-language-server");
    writeFileSync(fake, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    chmodSync(fake, 0o755);

    const model = scriptedModel([GOOD_EDIT]);
    const report = await runFixCommand({
      ...options,
      trusted: false,
      model,
      target: "src/a.ts:5",
    });

    expect(report.status).toBe("applied");
    expect(report.context.source).toBe("checker");
    expect(report.context.notes.join("\n")).toMatch(/not trusted/);
    expect(existsSync(marker)).toBe(false);
    expect(read()).toContain("String(total([1, 2]))");
  });

  it("(b) a trusted workspace gets context from the real typescript-language-server, and the checker still verifies", async () => {
    // The repo's own install is what detection must find for a trusted run.
    const detected = await detectServers(workspace, { trustWorkspace: true });
    const typescript = detected.find((s) => s.language === "typescript");
    expect(typescript?.available).toBe(true);
    if (typescript?.available !== true) return;
    expect(typescript.binaryPath.startsWith(REPO_ROOT)).toBe(true);

    const model = scriptedModel([GOOD_EDIT]);
    const report = await runFixCommand({
      ...options,
      trusted: true,
      model,
      target: "src/a.ts:5",
    });

    expect(report.status).toBe("applied");
    expect(report.context.source).toBe("lsp");
    expect(report.context.notes).toEqual([]);
    expect(report.candidates[0]?.layers.at(-1)).toMatchObject({ layer: "verify", pass: true });
    expect(read()).toContain("String(total([1, 2]))");
  }, 120_000);

  it("(c) a server timeout falls back to the checker's context, records a note, and still completes", async () => {
    const definitionsAt = async () => {
      throw new LspError("TIMEOUT", "textDocument/definition did not answer in time");
    };
    const model = scriptedModel([GOOD_EDIT]);
    const report = await runFixCommand({
      ...options,
      trusted: true,
      definitionsAt,
      model,
      target: "src/a.ts:5",
    });

    expect(report.status).toBe("applied");
    expect(report.context.source).toBe("checker");
    expect(report.context.notes.join("\n")).toMatch(/failed \(TIMEOUT\)/);
    expect(model.prompts[0]).toContain("definition of total");
    expect(read()).toContain("String(total([1, 2]))");
  });

  it("(d) a definition outside the workspace is dropped and never reaches the prompt", async () => {
    const outside = join(root, "outside.ts");
    writeFileSync(outside, "export const OUTSIDE_MARKER_7f3a = 1;\n");
    const definitionsAt = async () => [{ file: outside, line: 1, column: 14 }];

    const model = scriptedModel([GOOD_EDIT]);
    const report = await runFixCommand({
      ...options,
      trusted: true,
      definitionsAt,
      model,
      target: "src/a.ts:5",
    });

    expect(report.status).toBe("applied");
    expect(report.context.source).toBe("lsp");
    expect(report.context.notes.join("\n")).toMatch(
      /dropped \d+ definition\(s\) outside the workspace/,
    );
    expect(model.prompts[0]).not.toContain("OUTSIDE_MARKER_7f3a");
  });
});
