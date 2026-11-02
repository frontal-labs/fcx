import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The system prompt body of a prompts/*.md file: its leading comment header and blank lines removed. */
export function promptBody(file: string): string {
  const lines = readFileSync(file, "utf-8").split("\n");
  let start = 0;
  while (start < lines.length && (lines[start]?.startsWith("//") || lines[start] === "")) {
    start++;
  }
  return lines.slice(start).join("\n").trim();
}

/** A scripted model: returns queued outputs in order and records every prompt it was sent. */
export function queueModel(outputs: unknown[]) {
  const prompts: string[] = [];
  return {
    prompts,
    generateObject: async (req: { prompt: string }) => {
      prompts.push(req.prompt);
      if (outputs.length === 0) throw new Error("ran out of outputs");
      const object = outputs.shift();
      return { object, ms: 0, raw: "" };
    },
  };
}

/** A temporary workspace with a strict tsconfig, plus a separate directory for the index database. */
export function makeWorkspace(files: Record<string, string>): {
  ws: string;
  indexPath: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "fcx-recipe-"));
  const ws = join(root, "ws");
  mkdirSync(ws);
  writeFileSync(
    join(ws, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2022",
        noEmit: true,
      },
      include: ["src", "tests"],
    }),
  );
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(ws, path)), { recursive: true });
    writeFileSync(join(ws, path), text);
  }
  return {
    ws,
    indexPath: join(root, "index.db"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
