import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTsChecker } from "../src/index.js";

describe("tsconfig confinement", () => {
  let root: string;
  let ws: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fcx-confine-"));
    ws = join(root, "ws");
    mkdirSync(join(ws, "src"), { recursive: true });
    mkdirSync(join(root, "outside"));
    writeFileSync(join(root, "outside", "mod.ts"), "export const secret = 42;\n");
    writeFileSync(
      join(ws, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: "ESNext",
          moduleResolution: "bundler",
          paths: { "@out/*": ["../outside/*"] },
        },
        include: ["src", "../outside"],
      }),
    );
    writeFileSync(
      join(ws, "src", "a.ts"),
      'import { secret } from "@out/mod";\nexport const v: number = secret;\n',
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("never loads files outside the workspace, even through paths or include", () => {
    const file = join(ws, "src", "a.ts");
    const checker = createTsChecker(ws, file);
    try {
      const program = checker.service.getProgram();
      const outsideLoaded = program
        ?.getSourceFiles()
        .map((f) => f.fileName)
        .filter((name) => name.includes(join("outside", "mod.ts")));
      expect(outsideLoaded).toEqual([]);
      // The import no longer resolves, so the compiler reports it. The verify layer will not accept a fix that leaves it.
      const messages = checker.diagnostics(file).map((d) => d.code);
      expect(messages).toContain(2307);
    } finally {
      checker.dispose();
    }
  });
});
