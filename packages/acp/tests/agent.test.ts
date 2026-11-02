import { RequestError, methods } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { AcpConfigError, createAcpAgent } from "../src/index.js";
import { deferred, recordingHandler, withClient } from "./helpers.js";

const CWD = "/tmp/fcx-acp-test-workspace";

async function openSession(ctx: Parameters<Parameters<typeof withClient>[1]>[0]): Promise<string> {
  await ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
  const created = await ctx.request(methods.agent.session.new, { cwd: CWD, mcpServers: [] });
  return created.sessionId;
}

describe("createAcpAgent", () => {
  it("rejects a handler without runTask", () => {
    expect(() => createAcpAgent({ handler: {} as never })).toThrow(AcpConfigError);
  });

  it("rejects a missing handler", () => {
    expect(() => createAcpAgent({} as never)).toThrow(AcpConfigError);
  });
});

describe("initialize", () => {
  it("advertises only implemented capabilities", async () => {
    const { handler } = recordingHandler(async () => ({ stopReason: "end_turn", summary: "" }));
    const agent = createAcpAgent({ handler });
    const response = await withClient(agent, (ctx) =>
      ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} }),
    );
    expect(response.protocolVersion).toBe(1);
    expect(response.agentCapabilities?.loadSession).toBe(false);
    expect(response.agentCapabilities?.promptCapabilities).toEqual({
      image: false,
      audio: false,
      embeddedContext: false,
    });
    expect(response.agentCapabilities?.mcpCapabilities).toEqual({ http: false, sse: false });
    expect(response.authMethods).toEqual([]);
  });

  it("rejects requests sent before initialize", async () => {
    const { handler } = recordingHandler(async () => ({ stopReason: "end_turn", summary: "" }));
    const agent = createAcpAgent({ handler });
    await withClient(agent, async (ctx) => {
      await expect(
        ctx.request(methods.agent.session.new, { cwd: CWD, mcpServers: [] }),
      ).rejects.toMatchObject({ code: -32600 });
    });
  });
});

describe("session/new", () => {
  it("returns a session id bound to the requested cwd", async () => {
    const { handler, calls } = recordingHandler(async () => ({
      stopReason: "end_turn",
      summary: "",
    }));
    const agent = createAcpAgent({ handler });
    await withClient(agent, async (ctx) => {
      const sessionId = await openSession(ctx);
      expect(sessionId.length).toBeGreaterThan(0);
      await ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });
    });
    expect(calls[0]?.task.cwd).toBe(CWD);
  });

  it("rejects a relative cwd", async () => {
    const { handler } = recordingHandler(async () => ({ stopReason: "end_turn", summary: "" }));
    const agent = createAcpAgent({ handler });
    await withClient(agent, async (ctx) => {
      await ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
      await expect(
        ctx.request(methods.agent.session.new, { cwd: "relative/dir", mcpServers: [] }),
      ).rejects.toMatchObject({ code: -32602 });
    });
  });

  it("rejects MCP servers and additional directories, which are not supported", async () => {
    const { handler } = recordingHandler(async () => ({ stopReason: "end_turn", summary: "" }));
    const agent = createAcpAgent({ handler });
    await withClient(agent, async (ctx) => {
      await ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
      await expect(
        ctx.request(methods.agent.session.new, {
          cwd: CWD,
          mcpServers: [{ name: "x", command: "/bin/true", args: [], env: [] }],
        }),
      ).rejects.toMatchObject({ code: -32602 });
      await expect(
        ctx.request(methods.agent.session.new, {
          cwd: CWD,
          mcpServers: [],
          additionalDirectories: ["/tmp/other"],
        }),
      ).rejects.toMatchObject({ code: -32602 });
    });
  });
});

describe("session/prompt", () => {
  it("streams progress as thought chunks, sends the summary, and ends with end_turn", async () => {
    const { handler, calls } = recordingHandler(async (_task, progress) => {
      progress({ kind: "retrieval", message: "found 3 files" });
      progress({ kind: "check", message: "typecheck passed" });
      return { stopReason: "end_turn", summary: "Applied the fix." };
    });
    const agent = createAcpAgent({ handler });
    const result = await withClient(agent, async (ctx, updates) => {
      const sessionId = await openSession(ctx);
      const response = await ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "fix the import" }],
      });
      expect(updates.map((u) => u.sessionUpdate)).toEqual([
        "agent_thought_chunk",
        "agent_thought_chunk",
        "agent_message_chunk",
      ]);
      expect(updates[0]).toMatchObject({
        content: { type: "text", text: "retrieval: found 3 files" },
      });
      expect(updates[1]).toMatchObject({
        content: { type: "text", text: "check: typecheck passed" },
      });
      expect(updates[2]).toMatchObject({
        content: { type: "text", text: "Applied the fix." },
      });
      return response;
    });
    expect(result.stopReason).toBe("end_turn");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.task.text).toBe("fix the import");
    expect(calls[0]?.task.cwd).toBe(CWD);
  });

  it("joins text blocks and ignores non-text blocks", async () => {
    const { handler, calls } = recordingHandler(async () => ({
      stopReason: "end_turn",
      summary: "",
    }));
    const agent = createAcpAgent({ handler });
    await withClient(agent, async (ctx) => {
      const sessionId = await openSession(ctx);
      await ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [
          { type: "text", text: "first" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "text", text: "second" },
        ],
      });
    });
    expect(calls[0]?.task.text).toBe("first\nsecond");
  });

  it("rejects a prompt with no text", async () => {
    const { handler, calls } = recordingHandler(async () => ({
      stopReason: "end_turn",
      summary: "",
    }));
    const agent = createAcpAgent({ handler });
    await withClient(agent, async (ctx) => {
      const sessionId = await openSession(ctx);
      await expect(
        ctx.request(methods.agent.session.prompt, { sessionId, prompt: [] }),
      ).rejects.toMatchObject({ code: -32602 });
    });
    expect(calls).toHaveLength(0);
  });

  it("returns a not-found error for an unknown session", async () => {
    const { handler } = recordingHandler(async () => ({ stopReason: "end_turn", summary: "" }));
    const agent = createAcpAgent({ handler });
    await withClient(agent, async (ctx) => {
      await ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
      await expect(
        ctx.request(methods.agent.session.prompt, {
          sessionId: "no-such-session",
          prompt: [{ type: "text", text: "hi" }],
        }),
      ).rejects.toMatchObject({ code: -32002 });
    });
  });

  it("rejects a second prompt while one is active on the same session", async () => {
    const gate = deferred<void>();
    const { handler } = recordingHandler(async () => {
      await gate.promise;
      return { stopReason: "end_turn", summary: "" };
    });
    const agent = createAcpAgent({ handler });
    await withClient(agent, async (ctx) => {
      const sessionId = await openSession(ctx);
      const first = ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "one" }],
      });
      await expect(
        ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "two" }],
        }),
      ).rejects.toMatchObject({ code: -32600 });
      gate.resolve();
      await expect(first).resolves.toEqual({ stopReason: "end_turn" });
    });
  });

  it("reports a handler error as a JSON-RPC internal error without breaking the connection", async () => {
    let call = 0;
    const { handler } = recordingHandler(async () => {
      call += 1;
      if (call === 1) throw new Error("model backend unavailable");
      return { stopReason: "end_turn", summary: "recovered" };
    });
    const agent = createAcpAgent({ handler });
    await withClient(agent, async (ctx, updates) => {
      const sessionId = await openSession(ctx);
      await expect(
        ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "go" }],
        }),
      ).rejects.toMatchObject({ code: -32603 });
      expect(updates.at(-1)).toMatchObject({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "model backend unavailable" },
      });

      const next = await ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "again" }],
      });
      expect(next.stopReason).toBe("end_turn");
    });
  });

  it("rejects a handler that returns an unknown stop reason", async () => {
    const { handler } = recordingHandler(
      async () => ({ stopReason: "bogus", summary: "" }) as never,
    );
    const agent = createAcpAgent({ handler });
    await withClient(agent, async (ctx) => {
      const sessionId = await openSession(ctx);
      await expect(
        ctx.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "go" }],
        }),
      ).rejects.toMatchObject({ code: -32603 });
    });
  });
});

describe("session/cancel", () => {
  it("aborts the handler signal and returns stopReason cancelled", async () => {
    const started = deferred<void>();
    const { handler, calls } = recordingHandler(
      (_task, _progress, signal) =>
        new Promise((resolve) => {
          started.resolve();
          signal.addEventListener("abort", () => {
            resolve({ stopReason: "end_turn", summary: "" });
          });
        }),
    );
    const agent = createAcpAgent({ handler });
    const response = await withClient(agent, async (ctx) => {
      const sessionId = await openSession(ctx);
      const pending = ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "long task" }],
      });
      await started.promise;
      await ctx.notify(methods.agent.session.cancel, { sessionId });
      return pending;
    });
    expect(response.stopReason).toBe("cancelled");
    expect(calls[0]?.signal.aborted).toBe(true);
  });

  it("returns cancelled even when the handler ignores the signal", async () => {
    const started = deferred<void>();
    const never = deferred<void>();
    const { handler, calls } = recordingHandler(async () => {
      started.resolve();
      await never.promise;
      return { stopReason: "end_turn", summary: "late" };
    });
    const agent = createAcpAgent({ handler });
    const response = await withClient(agent, async (ctx) => {
      const sessionId = await openSession(ctx);
      const pending = ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "stubborn" }],
      });
      await started.promise;
      await ctx.notify(methods.agent.session.cancel, { sessionId });
      return pending;
    });
    expect(response.stopReason).toBe("cancelled");
    expect(calls[0]?.signal.aborted).toBe(true);
    never.resolve();
  });

  it("ignores cancel for a session with no active prompt", async () => {
    const { handler } = recordingHandler(async () => ({ stopReason: "end_turn", summary: "" }));
    const agent = createAcpAgent({ handler });
    await withClient(agent, async (ctx) => {
      const sessionId = await openSession(ctx);
      await ctx.notify(methods.agent.session.cancel, { sessionId });
      const response = await ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "after" }],
      });
      expect(response.stopReason).toBe("end_turn");
    });
  });
});

describe("unsupported and forbidden methods", () => {
  it("returns method not found for an unknown method", async () => {
    const { handler } = recordingHandler(async () => ({ stopReason: "end_turn", summary: "" }));
    const agent = createAcpAgent({ handler });
    await withClient(agent, async (ctx) => {
      await ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
      const failure = await ctx
        .request("fcx/does_not_exist", {})
        .then(() => null)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(RequestError);
      expect(failure).toMatchObject({ code: -32601 });
    });
  });

  it("never changes the permission mode: session/set_mode is not implemented", async () => {
    const { handler } = recordingHandler(async () => ({ stopReason: "end_turn", summary: "" }));
    const agent = createAcpAgent({ handler });
    await withClient(agent, async (ctx) => {
      const sessionId = await openSession(ctx);
      await expect(
        ctx.request(methods.agent.session.setMode, { sessionId, modeId: "auto" }),
      ).rejects.toMatchObject({ code: -32601 });
    });
  });

  it("does not implement session load, list, or resume", async () => {
    const { handler } = recordingHandler(async () => ({ stopReason: "end_turn", summary: "" }));
    const agent = createAcpAgent({ handler });
    await withClient(agent, async (ctx) => {
      await ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
      await expect(
        ctx.request(methods.agent.session.load, { sessionId: "x", cwd: CWD, mcpServers: [] }),
      ).rejects.toMatchObject({ code: -32601 });
      await expect(ctx.request(methods.agent.session.list, {})).rejects.toMatchObject({
        code: -32601,
      });
    });
  });
});
