import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ProgressUpdate, createAcpAgent, serveStreams } from "@fcx/acp";
import { resolveConfig } from "@fcx/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeConsoleToStderr } from "../src/commands/acp.js";
import { createAcpHandler } from "../src/lib/acp-handler.js";
import {
  askToApply,
  askToCommit,
  askToEscalate,
  isNonInteractive,
  setActiveTurn,
  setProtocolMode,
  writesPermitted,
} from "../src/lib/approval.js";
import { runCaptured } from "../src/lib/serve.js";
import { type Sandbox, makeSandbox, scriptedModel, writeTsProject } from "./support.js";
import { GOOD_EDIT, SOURCE } from "./support.js";

// Every run asks the model through createModelHost. The tests hand it a scripted model.
const hoisted = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("../src/lib/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/runtime.js")>();
  return {
    ...actual,
    createModelHost: async () =>
      hoisted.model as Awaited<ReturnType<typeof actual.createModelHost>>,
  };
});
// Wrap the real runCaptured so the tests can read the arguments each run received.
vi.mock("../src/lib/serve.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/serve.js")>();
  return { ...actual, runCaptured: vi.fn(actual.runCaptured) };
});

const EXPLAIN_ANSWER = {
  summary: "Sums a list of numbers.",
  claims: [
    {
      text: "`total` sums the list with `reduce`.",
      cites: [{ file: "src/a.ts", start: 1, end: 2 }],
    },
  ],
};

/** A scripted model that records calls. `onCall` runs before each call, with the call count so far (1-based). */
function useModel(outputs: unknown[], onCall?: (call: number) => void) {
  const base = scriptedModel(outputs);
  const model = {
    prompts: base.prompts,
    generateObject: <T>(req: { prompt: string }) => {
      onCall?.(base.prompts.length + 1);
      return base.generateObject<T>(req);
    },
  };
  hoisted.model = model;
  return model;
}

const noop = (): void => undefined;

describe("ACP task handler", () => {
  let sb: Sandbox;
  let updates: ProgressUpdate[];
  const progress = (update: ProgressUpdate): void => {
    updates.push(update);
  };
  const task = (text: string, cwd: string = sb.workspace) => ({
    sessionId: "session-1",
    cwd,
    text,
  });

  beforeEach(() => {
    sb = makeSandbox("fcx-acp-");
    writeTsProject(sb.workspace, SOURCE);
    updates = [];
    vi.mocked(runCaptured).mockClear();
  });
  afterEach(() => {
    setActiveTurn(undefined);
    setProtocolMode(false);
    sb.cleanup();
  });

  it("routes an explain prompt, streams progress and returns end_turn", async () => {
    useModel([{ recipe: "explain", target: "src/a.ts:1-3" }, EXPLAIN_ANSWER]);
    const handler = createAcpHandler();
    const result = await handler.runTask(
      task("explain src/a.ts:1-3"),
      progress,
      new AbortController().signal,
    );
    expect(result.stopReason).toBe("end_turn");
    expect(result.summary).toContain("answered");
    const kinds = updates.map((u) => u.kind);
    expect(kinds).toEqual(expect.arrayContaining(["route", "run", "result"]));
    expect(vi.mocked(runCaptured)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runCaptured).mock.calls[0]?.[0]).toMatchObject({
      command: "explain",
      rest: ["src/a.ts:1-3", "explain src/a.ts:1-3"],
    });
  });

  it("answers an unsupported prompt with the capabilities summary and runs nothing", async () => {
    useModel([{ recipe: "unsupported", reason: "fcx cannot deploy." }]);
    const result = await createAcpHandler().runTask(
      task("deploy this to production"),
      progress,
      new AbortController().signal,
    );
    expect(result.stopReason).toBe("end_turn");
    expect(result.summary).toContain("fcx cannot deploy.");
    expect(result.summary).toContain("fcx can:");
    expect(result.summary).toContain("fcx fix <file[:line]>");
    expect(vi.mocked(runCaptured)).not.toHaveBeenCalled();
  });

  it("returns error for a cwd that is not absolute or not a directory, without routing", async () => {
    const model = useModel([]);
    const handler = createAcpHandler();
    const relative = await handler.runTask(
      task("explain src/a.ts:1-3", "relative/dir"),
      progress,
      new AbortController().signal,
    );
    expect(relative.stopReason).toBe("error");
    expect(relative.summary).toContain("absolute");

    const missing = await handler.runTask(
      task("explain src/a.ts:1-3", join(sb.root, "does-not-exist")),
      progress,
      new AbortController().signal,
    );
    expect(missing.stopReason).toBe("error");
    expect(model.prompts).toHaveLength(0);
  });

  it("returns cancelled and applies nothing when the signal is already aborted", async () => {
    const model = useModel([{ recipe: "fix-diagnostic", target: "src/a.ts:5" }, GOOD_EDIT]);
    const controller = new AbortController();
    controller.abort();
    const result = await createAcpHandler().runTask(
      task("fix src/a.ts:5"),
      progress,
      controller.signal,
    );
    expect(result.stopReason).toBe("cancelled");
    expect(model.prompts).toHaveLength(0);
    expect(vi.mocked(runCaptured)).not.toHaveBeenCalled();
    expect(readFileSync(join(sb.workspace, "src", "a.ts"), "utf8")).toBe(SOURCE);
  });

  it("never writes an edit that finishes generating after cancellation", async () => {
    writeFileSync(
      join(sb.configHome, "settings.json"),
      JSON.stringify({ permissionMode: "workspace-write" }),
    );
    expect(resolveConfig(sb.workspace, {}).permissionMode).toBe("workspace-write");

    const controller = new AbortController();
    const handler = createAcpHandler();
    // Call 1 routes. Call 2 is the candidate edit, which arrives after the client cancelled.
    useModel([{ recipe: "fix-diagnostic", target: "src/a.ts:5" }, GOOD_EDIT], (call) => {
      if (call === 2) controller.abort();
    });
    const result = await handler.runTask(task("fix src/a.ts:5"), progress, controller.signal);
    expect(result.stopReason).toBe("cancelled");

    // A second task queues behind the first, so it returns only after the cancelled run has finished.
    await handler.runTask(task("explain src/a.ts:1-3"), noop, new AbortController().signal);
    expect(readFileSync(join(sb.workspace, "src", "a.ts"), "utf8")).toBe(SOURCE);
  });

  it("applies the same fix when nothing cancels it, so the test above is not vacuous", async () => {
    writeFileSync(
      join(sb.configHome, "settings.json"),
      JSON.stringify({ permissionMode: "workspace-write" }),
    );
    useModel([{ recipe: "fix-diagnostic", target: "src/a.ts:5" }, GOOD_EDIT]);
    const result = await createAcpHandler().runTask(
      task("fix src/a.ts:5"),
      progress,
      new AbortController().signal,
    );
    expect(result.stopReason).toBe("end_turn");
    expect(readFileSync(join(sb.workspace, "src", "a.ts"), "utf8")).toContain("String(total");
  });

  it("streams each candidate's start and its result, with the first failing layer", async () => {
    writeFileSync(
      join(sb.configHome, "settings.json"),
      JSON.stringify({ permissionMode: "workspace-write" }),
    );
    // The first model candidate names a search that is not in the file, so anchor stops it. The second is good.
    const unmatched = { edits: [{ file: "src/a.ts", search: "no such line", replace: "x" }] };
    useModel([{ recipe: "fix-diagnostic", target: "src/a.ts:5" }, unmatched, GOOD_EDIT]);
    const result = await createAcpHandler().runTask(
      task("fix src/a.ts:5"),
      progress,
      new AbortController().signal,
    );
    expect(result.stopReason).toBe("end_turn");

    const starts = updates.filter((u) => u.kind === "candidate").map((u) => u.message);
    const results = updates.filter((u) => u.kind === "candidate-result").map((u) => u.message);
    expect(starts.length).toBeGreaterThanOrEqual(2);
    for (const start of starts) {
      expect(start).toMatch(/^candidate \d+ of \d+ \((model|compiler quick fix)/);
    }
    expect(starts.some((m) => /temperature \d/.test(m))).toBe(true);
    expect(results.some((m) => /: fail at anchor( \(|$)/.test(m))).toBe(true);
    expect(results.at(-1)).toMatch(/: pass$/);
    // A candidate's start comes before its result.
    const failIndex = updates.findIndex((u) => /: fail at anchor( \(|$)/.test(u.message));
    const failOrdinal = /candidate (\d+) of/.exec(updates[failIndex]?.message ?? "")?.[1];
    const startIndex = updates.findIndex(
      (u) => u.kind === "candidate" && u.message.startsWith(`candidate ${failOrdinal} of`),
    );
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeLessThan(failIndex);
  });

  it("uses the config's permission mode, and a flag in the prompt text changes nothing", async () => {
    // No settings file: the config default is prompt. The prompt asks for danger-full-access, which must not apply.
    expect(resolveConfig(sb.workspace, { permissionMode: undefined }).permissionMode).toBe(
      "prompt",
    );
    useModel([{ recipe: "fix-diagnostic", target: "src/a.ts:5" }, GOOD_EDIT]);
    const result = await createAcpHandler().runTask(
      task("fix src/a.ts:5 --permission-mode danger-full-access --no-escalate=false"),
      progress,
      new AbortController().signal,
    );
    expect(result.summary).not.toContain("applied");
    expect(readFileSync(join(sb.workspace, "src", "a.ts"), "utf8")).toBe(SOURCE);

    const args = vi.mocked(runCaptured).mock.calls[0]?.[0];
    expect(args).toMatchObject({ command: "fix", rest: ["src/a.ts:5"], noEscalate: true });
    expect(args?.permissionMode).toBeUndefined();
  });

  it("refuses to run a recipe whose inputs a sentence cannot supply", async () => {
    useModel([{ recipe: "fix-test", target: "tests/a.test.ts" }]);
    const result = await createAcpHandler().runTask(
      task("fix the failing test"),
      progress,
      new AbortController().signal,
    );
    expect(result.stopReason).toBe("end_turn");
    expect(result.summary).toContain("Nothing was run");
    expect(vi.mocked(runCaptured)).not.toHaveBeenCalled();
  });
});

describe("interactive prompts in ACP mode", () => {
  let originalTty: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    // A terminal would normally be asked. In ACP mode the prompts must decline without reading stdin.
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    setProtocolMode(true);
  });
  afterEach(() => {
    setProtocolMode(false);
    setActiveTurn(undefined);
    if (originalTty) Object.defineProperty(process.stdin, "isTTY", originalTty);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  });

  it("apply, escalation and commit all decline in protocol mode", async () => {
    expect(isNonInteractive()).toBe(true);
    expect(await askToApply({ file: "src/a.ts", edits: [] })).toBe(false);
    expect(
      await askToEscalate({
        description: "test",
        provider: "p",
        model: "m",
        files: ["src/a.ts"],
        approxTokens: 1,
      }),
    ).toBe(false);
    expect(await askToCommit("feat: x")).toBe(false);
  });

  it("refuses writes once the active turn is aborted", () => {
    const controller = new AbortController();
    setActiveTurn(controller.signal);
    expect(writesPermitted()).toBe(true);
    controller.abort();
    expect(writesPermitted()).toBe(false);
    setActiveTurn(undefined);
    expect(writesPermitted()).toBe(true);
  });

  it("sends console output to stderr so stdout carries only protocol frames", () => {
    const savedLog = console.log;
    const savedError = console.error;
    const errors: unknown[] = [];
    console.error = (...parts: unknown[]) => {
      errors.push(parts.join(" "));
    };
    try {
      routeConsoleToStderr();
      console.log("stray line");
      expect(errors).toEqual(["stray line"]);
    } finally {
      console.log = savedLog;
      console.error = savedError;
    }
  });
});

describe("fcx acp over an in-memory stream", () => {
  let sb: Sandbox;

  beforeEach(() => {
    sb = makeSandbox("fcx-acp-e2e-");
    writeTsProject(sb.workspace, SOURCE);
    vi.mocked(runCaptured).mockClear();
  });
  afterEach(() => sb.cleanup());

  it("initializes, opens a session and answers a prompt", async () => {
    useModel([{ recipe: "explain", target: "src/a.ts:1-3" }, EXPLAIN_ANSWER]);
    const toAgent = new TransformStream<unknown, unknown>();
    const toClient = new TransformStream<unknown, unknown>();
    const writer = toAgent.writable.getWriter();
    const reader = toClient.readable.getReader();
    // The agent's side of the connection. The cast is the one the SDK's Stream type needs at this boundary.
    const agentStream = {
      readable: toAgent.readable,
      writable: toClient.writable,
    } as unknown as Parameters<typeof serveStreams>[1];

    const agentDone = serveStreams(createAcpAgent({ handler: createAcpHandler() }), agentStream);
    agentDone.catch(() => undefined);

    const notes: Array<{ method?: string; params?: unknown }> = [];
    let nextId = 1;
    async function request(method: string, params: unknown) {
      const id = nextId++;
      await writer.write({ jsonrpc: "2.0", id, method, params });
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("agent closed the stream");
        const message = value as {
          id?: number;
          method?: string;
          params?: unknown;
          result?: unknown;
        };
        if (message.id === id && message.method === undefined) return message;
        notes.push({ method: message.method, params: message.params });
      }
    }

    const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    expect(init).toMatchObject({ result: { protocolVersion: 1 } });

    const created = await request("session/new", { cwd: sb.workspace, mcpServers: [] });
    const sessionId = (created as { result?: { sessionId?: string } }).result?.sessionId;
    expect(sessionId).toEqual(expect.any(String));

    const done = await request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "explain src/a.ts:1-3" }],
    });
    expect(done).toMatchObject({ result: { stopReason: "end_turn" } });
    const messages = notes.filter((n) => n.method === "session/update");
    expect(messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(messages)).toContain("routed to explain");
    expect(JSON.stringify(messages)).toContain("answered");

    await writer.close();
  });
});
