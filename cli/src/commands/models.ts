import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ModelRegistryEntry,
  defaultGenerationModel,
  downloadEntry,
  entryState,
  listModels,
  modelsDir,
} from "@fcx/model";
import type { GlobalArgs } from "../args.js";
import { emit } from "../output.js";

/** `fcx models list|pull|bench [id]`. Models with downloadable files are managed here; ggml-node's own models go through its CLI. */
export interface ModelsReport {
  status: "ok" | "error";
  action: "list" | "pull" | "bench";
  dir?: string;
  models?: {
    id: string;
    kind: string;
    quant?: string;
    license: string;
    state: string;
    default: boolean;
    path?: string;
  }[];
  downloaded?: string[];
  skipped?: string[];
  message?: string;
}

/** The ggml-node CLI script, found through the CLI's own dependency so it works from any directory. */
function ggmlNodeBin(): string | undefined {
  try {
    // The package does not export its package.json, so start from its entry point and walk up to the package root.
    // ggml-node exports only its import entry, so resolve it as an ES module.
    const entry = fileURLToPath(import.meta.resolve("ggml-node"));
    for (let dir = dirname(entry); ; dir = dirname(dir)) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          name?: string;
          bin?: Record<string, string>;
        };
        if (pkg.name === "ggml-node") {
          const rel = pkg.bin?.["ggml-node"];
          return rel === undefined ? undefined : join(dir, rel);
        }
      }
      if (dirname(dir) === dir) return undefined;
    }
  } catch {
    return undefined;
  }
}

/** Runs the ggml-node CLI with the given arguments. Output is inherited so progress and results reach the terminal. */
function runGgmlNode(args: string[]): number {
  const bin = ggmlNodeBin();
  if (bin === undefined) {
    process.stderr.write("ggml-node is not installed; run `bun install` first.\n");
    return 1;
  }
  const result = spawnSync(process.execPath, [bin, ...args], { stdio: "inherit" });
  return result.status ?? 1;
}

/** Cache state of a ggml-node model from `ggml-node list`, or "unknown" when that cannot be read. */
function ggmlNodeCached(id: string): string {
  const bin = ggmlNodeBin();
  if (bin === undefined) return "unknown";
  const result = spawnSync(process.execPath, [bin, "list"], { encoding: "utf8" });
  if (result.status !== 0) return "unknown";
  // The id column is not always followed by a space (the size can start right after a long id), so match the prefix
  // and read the CACHED column, which is a whole word yes or no.
  const row = result.stdout.split("\n").find((line) => line.startsWith(id));
  if (row === undefined) return "unknown";
  const cached = /\s(yes|no)\s/.exec(row)?.[1];
  return cached === "no" ? "missing" : cached === "yes" ? "installed" : "unknown";
}

async function stateOf(dir: string, entry: ModelRegistryEntry): Promise<string> {
  if (entry.files !== undefined && entry.files.length > 0) return entryState(dir, entry);
  return ggmlNodeCached(entry.id);
}

export async function runModelsCommand(args: GlobalArgs): Promise<number> {
  const [sub, id] = args.rest;
  const dir = modelsDir();
  const outputFormat = args.outputFormat;
  const fail = (message: string): number => {
    emit(
      outputFormat,
      { status: "error", action: sub === "pull" || sub === "bench" ? sub : "list", message },
      () => message,
    );
    return 1;
  };

  if (sub === undefined || sub === "list") {
    const def = defaultGenerationModel();
    const models: NonNullable<ModelsReport["models"]> = [];
    for (const entry of listModels()) {
      models.push({
        id: entry.id,
        kind: entry.kind,
        quant: entry.quant,
        license: entry.license,
        state: await stateOf(dir, entry),
        default: entry.id === def,
        path: entry.files !== undefined && entry.files.length > 0 ? dir : undefined,
      });
    }
    const report: ModelsReport = { status: "ok", action: "list", dir, models };
    emit(outputFormat, report, () =>
      [
        `models folder: ${dir}`,
        ...models.map(
          (m) =>
            `${m.default ? "*" : " "} ${m.id.padEnd(20)} ${m.kind.padEnd(10)} ${(m.quant ?? "").padEnd(8)} ${m.state}`,
        ),
        "* default generation model. Run `fcx models pull <id>` to download a model.",
      ].join("\n"),
    );
    return 0;
  }

  if (sub === "pull") {
    if (id === undefined) return fail("usage: fcx models pull <id>");
    const entry = listModels().find((m) => m.id === id || `ggml/${m.id}` === id);
    if (entry === undefined) return fail(`unknown model: ${id}`);
    if (entry.files === undefined || entry.files.length === 0) {
      return runGgmlNode(["pull", entry.id]);
    }
    const onProgress = (p: { file: string; received: number; total: number }) => {
      if (outputFormat === "text" && process.stdout.isTTY) {
        const pct = Math.floor((p.received / p.total) * 100);
        process.stdout.write(`\r${p.file}: ${pct}%`);
      }
    };
    try {
      const result = await downloadEntry(dir, entry, onProgress);
      if (process.stdout.isTTY) process.stdout.write("\n");
      const report: ModelsReport = { status: "ok", action: "pull", dir, ...result };
      emit(outputFormat, report, () =>
        [
          `${entry.id} in ${dir}`,
          ...result.downloaded.map((f) => `  downloaded ${f}`),
          ...result.skipped.map((f) => `  already installed ${f}`),
        ].join("\n"),
      );
      return 0;
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  if (sub === "bench") {
    return runGgmlNode(["bench", ...(id === undefined ? [] : [id])]);
  }

  return fail(`usage: fcx models list | pull <id> | bench [id] (got "${sub}")`);
}
