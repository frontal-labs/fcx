import { describe, expect, it } from "vitest";
import { verifyCandidate } from "../src/dispatch.js";
import { findExecutable, runArgv } from "../src/exec.js";
import { parseGoVetOutput } from "../src/go.js";
import { verifyGo } from "../src/go.js";
import { languageForPath } from "../src/language.js";
import { parsePyCompileOutput, parsePyflakesOutput } from "../src/python.js";
import { executionFailure, filterOriginal, toErrors } from "../src/run.js";
import { parseCargoShortOutput } from "../src/rust.js";

describe("parseGoVetOutput", () => {
  it("parses type errors and vet findings with ./ and vet: prefixes", () => {
    const output = [
      "# example.com/m",
      "./main.go:7:2: undefined: foo",
      "vet: ./util/x.go:3:9: fmt.Sprintf format %d has arg of wrong type string",
      "",
    ].join("\n");
    expect(parseGoVetOutput(output)).toEqual([
      { path: "main.go", line: 7, message: "undefined: foo" },
      { path: "util/x.go", line: 3, message: "fmt.Sprintf format %d has arg of wrong type string" },
    ]);
  });

  it("returns nothing for a clean run", () => {
    expect(parseGoVetOutput("")).toEqual([]);
  });
});

describe("parsePyCompileOutput", () => {
  it("takes the line from the File frame and the SyntaxError line", () => {
    const output = [
      '  File "/tmp/fcx-verify-abc/app.py", line 3',
      "    def f(:",
      "          ^",
      "SyntaxError: invalid syntax",
      "",
    ].join("\n");
    expect(parsePyCompileOutput(output)).toEqual([
      { line: 3, message: "SyntaxError: invalid syntax" },
    ]);
  });

  it("handles IndentationError", () => {
    const output =
      '  File "/tmp/x/app.py", line 2\n    return 1\nIndentationError: unexpected indent\n';
    expect(parsePyCompileOutput(output)).toEqual([
      { line: 2, message: "IndentationError: unexpected indent" },
    ]);
  });
});

describe("parsePyflakesOutput", () => {
  it("parses path:line:col: message lines", () => {
    const output = "/tmp/x/app.py:1:1: 'os' imported but unused\n";
    expect(parsePyflakesOutput(output)).toEqual([{ line: 1, message: "'os' imported but unused" }]);
  });
});

describe("parseCargoShortOutput", () => {
  it("keeps error lines with a location and skips warnings and summary lines", () => {
    const output = [
      "src/main.rs:2:5: error[E0425]: cannot find value `y` in this scope",
      "src/main.rs:1:7: warning: unused variable: `x`",
      'error: could not compile `demo` (bin "demo") due to 1 previous error',
      "",
    ].join("\n");
    expect(parseCargoShortOutput(output)).toEqual([
      { path: "src/main.rs", line: 2, message: "cannot find value `y` in this scope" },
    ]);
  });
});

describe("toErrors and filterOriginal", () => {
  it("drops one error per matching original message and keeps the rest", () => {
    const errors = [
      { line: 4, message: "undefined: a" },
      { line: 9, message: "undefined: a" },
      { line: 2, message: "undefined: b" },
    ];
    expect(filterOriginal(errors, [{ line: 1, message: "undefined: a" }])).toEqual([
      { line: 9, message: "undefined: a" },
      { line: 2, message: "undefined: b" },
    ]);
  });

  it("prefixes errors that are in another file with its path", () => {
    const result = toErrors([{ path: "other.go", line: 5, message: "boom" }], "main.go");
    expect(result).toEqual([{ line: 5, message: "other.go: boom" }]);
  });
});

describe("languageForPath", () => {
  it("maps .go, .py and .rs and leaves others to the TypeScript or unknown branches", () => {
    expect(languageForPath("/w/a.go")).toBe("go");
    expect(languageForPath("/w/a.py")).toBe("python");
    expect(languageForPath("/w/a.rs")).toBe("rust");
    expect(languageForPath("/w/a.ts")).toBe("typescript");
    expect(languageForPath("/w/a.tsx")).toBe("typescript");
    expect(languageForPath("/w/a.txt")).toBe("unknown");
    expect(languageForPath("/w/Makefile")).toBe("unknown");
  });
});

describe("verifyCandidate dispatch", () => {
  const workspace = "/w";

  it("returns unavailable with a reason for TypeScript", async () => {
    const result = await verifyCandidate({ workspace, file: "/w/a.ts", candidateText: "x" });
    expect(result.language).toBe("typescript");
    expect(result.available).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.reason).toContain("createTsChecker");
  });

  it("returns unavailable with a reason for an unknown language", async () => {
    const result = await verifyCandidate({ workspace, file: "/w/notes.txt", candidateText: "x" });
    expect(result.language).toBe("unknown");
    expect(result.available).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.reason).toBe("no verifier for .txt");
  });

  it("refuses a file outside the workspace without running anything", async () => {
    const result = await verifyGo({
      workspace,
      file: "/elsewhere/a.go",
      candidateText: "package a\n",
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBe("file is outside the workspace");
  });
});

describe("runner and failure handling", () => {
  it("kills a child that exceeds its timeout", async () => {
    const result = await runArgv([process.execPath, "-e", "setTimeout(() => {}, 20000)"], {
      cwd: process.cwd(),
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
  });

  it("caps captured output and sets truncated", async () => {
    const result = await runArgv(
      [process.execPath, "-e", "process.stdout.write('x'.repeat(5000))"],
      {
        cwd: process.cwd(),
        timeoutMs: 10_000,
        maxBytes: 100,
      },
    );
    expect(result.stdout.length).toBeLessThanOrEqual(100);
    expect(result.truncated).toBe(true);
  });

  it("reports a missing program as a spawn error, not a throw", async () => {
    const result = await runArgv(["/nonexistent/definitely-not-here"], {
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(result.spawnError).toBeDefined();
  });

  it("finds executables on PATH without a shell and returns undefined for unknown names", () => {
    expect(findExecutable(process.execPath)).toBe(process.execPath);
    expect(findExecutable("fcx-no-such-tool-xyz")).toBeUndefined();
  });

  it("describes a timeout as TIMEOUT with the tool and limit", () => {
    const timedOut = { exitCode: null, timedOut: true, stdout: "", stderr: "", truncated: false };
    expect(executionFailure("go", "go vet", timedOut, 1000)?.reason).toBe(
      "TIMEOUT: go vet exceeded 1000 ms",
    );
  });

  it("reports unavailable when the toolchain is not on PATH", async () => {
    const saved = process.env.PATH;
    process.env.PATH = "";
    try {
      const result = await verifyGo({
        workspace: "/tmp",
        file: "/tmp/fcx-no-go/main.go",
        candidateText: "package main\n",
      });
      expect(result.available).toBe(false);
      expect(result.reason).toBe("go not found on PATH");
    } finally {
      process.env.PATH = saved;
    }
  });
});
