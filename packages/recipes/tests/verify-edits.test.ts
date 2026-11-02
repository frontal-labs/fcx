import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Checker, createTsChecker, errorsOnly } from "@fcx/verify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFixDiagnostic, verifyEdits } from "../src/index.js";
import { queueModel } from "./support.js";

const SOURCE = 'export const n: number = "5";\n';

describe("verifyEdits", () => {
  let ws: string;
  let file: string;
  let checker: Checker;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "fcx-verify-edits-"));
    mkdirSync(join(ws, "src"));
    writeFileSync(
      join(ws, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    );
    file = join(ws, "src", "a.ts");
    writeFileSync(file, SOURCE);
    checker = createTsChecker(ws, file);
  });

  afterEach(() => {
    checker.dispose();
    rmSync(ws, { recursive: true, force: true });
  });

  const summarize = (layers: readonly { layer: string; pass: boolean }[]) =>
    layers.map((l) => [l.layer, l.pass]);

  it("gives the same layer outcomes as the engine for a candidate that passes", async () => {
    const model = queueModel([{ edits: [{ file: "src/a.ts", search: '"5"', replace: "5" }] }]);
    const result = await runFixDiagnostic({
      checker,
      workspace: ws,
      file,
      maxCandidates: 1,
      model,
    });
    expect(result.status).toBe("verified");
    if (result.status !== "verified") return;

    const engineCandidate = result.candidates.find((c) => c.source === "model" && c.pass);
    expect(engineCandidate).toBeDefined();

    const verdict = verifyEdits({
      edits: result.edits,
      workspace: ws,
      allowedFiles: [file],
      primaryFile: file,
      text: result.baseText,
      checker,
      target: result.diagnostic,
      originalErrors: errorsOnly(checker.diagnostics(file)),
    });

    expect(verdict.pass).toBe(true);
    expect(summarize(verdict.layers)).toEqual(summarize(engineCandidate?.layers ?? []));
    expect(summarize(verdict.layers)).toEqual([
      ["constrain", true],
      ["anchor", true],
      ["verify", true],
    ]);
  });

  it("rejects with the same layer and feedback as the engine for a candidate that fails", async () => {
    const bad = [{ file: "src/a.ts", search: "nothing here", replace: "x" }];
    const model = queueModel([{ edits: bad }, { edits: bad }]);
    const result = await runFixDiagnostic({
      checker,
      workspace: ws,
      file,
      maxCandidates: 2,
      model,
    });
    expect(result.status).toBe("abstained");
    if (result.status !== "abstained") return;

    const engineLast = result.candidates.at(-1);
    const verdict = verifyEdits({
      edits: bad,
      workspace: ws,
      allowedFiles: [file],
      primaryFile: file,
      text: readFileSync(file, "utf-8"),
      checker,
      target: result.diagnostic,
      originalErrors: errorsOnly(checker.diagnostics(file)),
    });

    expect(verdict.pass).toBe(false);
    expect(summarize(verdict.layers)).toEqual(summarize(engineLast?.layers ?? []));
    if (!verdict.pass) expect(verdict.feedback).toBe(result.lastError);
  });

  it("rejects an edit outside the allowed files at the constrain layer", () => {
    const errors = errorsOnly(checker.diagnostics(file));
    const target = errors[0];
    expect(target).toBeDefined();
    if (!target) return;
    const verdict = verifyEdits({
      edits: [{ file: "src/other.ts", search: "x", replace: "y" }],
      workspace: ws,
      allowedFiles: [file],
      primaryFile: file,
      text: SOURCE,
      checker,
      target,
      originalErrors: errors,
    });
    expect(verdict.pass).toBe(false);
    expect(summarize(verdict.layers)).toEqual([["constrain", false]]);
  });
});
