import { PassThrough } from "node:stream";
import { FcError } from "@fcx/config";
import { describe, expect, it, vi } from "vitest";
import type { GlobalArgs } from "../src/args.js";
import { parseGlobalArgs } from "../src/args.js";
import { runTui, tokenize } from "../src/lib/tui.js";

describe("tokenize", () => {
  it("splits on whitespace", () => {
    expect(tokenize("  explain   a.ts:1-3  ")).toEqual(["explain", "a.ts:1-3"]);
  });

  it("keeps quoted text together, with either quote style", () => {
    expect(tokenize(`explain a.ts:1-3 "what does this do?" 'and this'`)).toEqual([
      "explain",
      "a.ts:1-3",
      "what does this do?",
      "and this",
    ]);
  });

  it("honours backslash escapes outside and inside double quotes", () => {
    expect(tokenize(String.raw`a\ b "c\"d"`)).toEqual(["a b", 'c"d']);
  });

  it("returns no words for a blank line", () => {
    expect(tokenize("   ")).toEqual([]);
  });

  it("rejects an unclosed quote", () => {
    expect(() => tokenize(`explain "unclosed`)).toThrow('unclosed " quote');
  });
});

describe("runTui", () => {
  /**
   * Drives the UI through pipes. A line is written only after the previous prompt has appeared: readline
   * drops lines that arrive while no question is pending, which a real terminal never does.
   */
  async function drive(
    lines: string[],
    dispatch: (args: GlobalArgs) => Promise<number>,
  ): Promise<{ exitCode: number; output: string }> {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    const prompts = () => text.split("fcx> ").length - 1;
    const done = runTui(dispatch, "/work", { input, output });
    for (let i = 0; i < lines.length; i++) {
      await waitFor(() => prompts() > i);
      input.write(`${lines[i]}\n`);
    }
    const exitCode = await done;
    return { exitCode, output: text };
  }

  async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the prompt");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it("runs each command line through dispatch and stops at /exit", async () => {
    const seen: GlobalArgs[] = [];
    const { exitCode, output } = await drive(
      ["status", 'explain a.ts:1-3 "what is this?"', "/exit"],
      async (args) => {
        seen.push(args);
        return 0;
      },
    );
    expect(exitCode).toBe(0);
    expect(seen.map((args) => args.command)).toEqual(["status", "explain"]);
    expect(seen[1]?.rest).toEqual(["a.ts:1-3", "what is this?"]);
    expect(output).toContain("(exit 0)");
  });

  it("passes global flags through to the command", async () => {
    const seen: GlobalArgs[] = [];
    await drive(["--permission-mode read-only status", "/exit"], async (args) => {
      seen.push(args);
      return 0;
    });
    expect(seen[0]?.permissionMode).toBe("read-only");
    expect(seen[0]?.command).toBe("status");
  });

  it("shows help without dispatching", async () => {
    const dispatch = vi.fn(async () => 0);
    const { output } = await drive(["/help", "/exit"], dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    expect(output).toContain("Built-ins:");
  });

  it("reports an unclosed quote without dispatching", async () => {
    const dispatch = vi.fn(async () => 0);
    const { output } = await drive(['explain "open', "/exit"], dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    expect(output).toContain('unclosed " quote');
  });

  it("prints a FcError with its code and hint, and keeps going", async () => {
    let calls = 0;
    const { exitCode, output } = await drive(["explain", "status", "/exit"], async () => {
      calls++;
      if (calls === 1) throw new FcError("no such file", "NOT_FOUND", "check the path");
      return 0;
    });
    expect(exitCode).toBe(0);
    expect(calls).toBe(2);
    expect(output).toContain("NOT_FOUND: no such file");
    expect(output).toContain("check the path");
    expect(output).toContain("(exit 0)");
  });

  it("records the exit code of a failed command", async () => {
    const { output } = await drive(["status", "/exit"], async () => 1);
    expect(output).toContain("(exit 1)");
  });

  it("does not treat tui as a nested command", async () => {
    const dispatch = vi.fn(async () => 0);
    const { output } = await drive(["tui", "/exit"], dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    expect(output).toContain("Already in the terminal UI.");
  });
});
