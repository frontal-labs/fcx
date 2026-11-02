/**
 * Times the non-model stages of `fcx fix` on a generated project: checker startup (cold), the compiler quick
 * fix, context gathering, and one verify call (warm). The model stage is measured by evals/run.ts.
 *
 * Usage: bun benchmarks/fix-stages.ts [--files N] [--runs N]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verify } from "../packages/defense/src/index.ts";
import { gatherFixContext } from "../packages/retrieve/src/index.ts";
import {
  type Diagnostic,
  compilerFix,
  createTsChecker,
  errorsOnly,
} from "../packages/verify/src/index.ts";

const args = process.argv.slice(2);
const numberFlag = (name: string, fallback: number): number => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const FILES = numberFlag("--files", 200);
const RUNS = numberFlag("--runs", 5);

const ws = mkdtempSync(join(tmpdir(), "fcx-bench-"));
try {
  mkdirSync(join(ws, "src"));
  writeFileSync(
    join(ws, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
  );
  for (let i = 0; i < FILES; i++) {
    const deps = i > 0 ? `import { fn${i - 1} } from "./m${i - 1}";\n` : "";
    const body = i > 0 ? `fn${i - 1}() + ${i}` : `${i}`;
    writeFileSync(
      join(ws, "src", `m${i}.ts`),
      `${deps}export function fn${i}(): number {\n  return ${body};\n}\n`,
    );
  }
  // The file under repair: a missing import of fn0, with one type error.
  const target = join(ws, "src", "target.ts");
  const original = 'export const value: number = fn0();\nexport const label: string = "a";\n';
  writeFileSync(target, original);

  const median = (xs: number[]) =>
    [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
  const ms = (fn: () => void) => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };

  const startup: number[] = [];
  const quick: number[] = [];
  const gather: number[] = [];
  const verifyWarm: number[] = [];
  let errorsSeen = 0;

  for (let run = 0; run < RUNS; run++) {
    let checker: ReturnType<typeof createTsChecker> | undefined;
    startup.push(
      ms(() => {
        checker = createTsChecker(ws, target);
        errorsSeen = errorsOnly(checker.diagnostics(target)).length;
      }),
    );
    const c = checker as ReturnType<typeof createTsChecker>;
    const errors = errorsOnly(c.diagnostics(target));
    const first = errors[0];
    if (!first) throw new Error("benchmark file has no error");
    quick.push(ms(() => compilerFix(c, target, original, first)));
    gather.push(
      ms(() =>
        gatherFixContext({
          checker: c,
          workspace: ws,
          file: target,
          line: first.line,
          column: first.column,
        }),
      ),
    );
    verifyWarm.push(
      ms(() => {
        verify({
          checker: c,
          file: target,
          workspace: ws,
          candidateText: original.replace('"a"', "1"),
          target: second(errors),
          originalErrors: errors,
        });
      }),
    );
    c.dispose();
  }

  const report = {
    files: FILES,
    runs: RUNS,
    errorsInTarget: errorsSeen,
    medianMs: {
      checkerStartupAndFirstDiagnostics: round(median(startup)),
      compilerQuickFix: round(median(quick)),
      contextGather: round(median(gather)),
      verifyWarmCall: round(median(verifyWarm)),
    },
    node: process.version,
    cpu: process.arch,
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(ws, { recursive: true, force: true });
}

function second(errors: readonly Diagnostic[]): Diagnostic {
  const e = errors[1] ?? errors[0];
  if (!e) throw new Error("no errors");
  return e;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
