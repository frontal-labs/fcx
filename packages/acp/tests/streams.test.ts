import {
  type AnyMessage,
  type Stream,
  client,
  methods,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { createAcpAgent, serveStdio, serveStreams } from "../src/index.js";
import { recordingHandler, withClient } from "./helpers.js";

function initializeVia(stream: Stream): Promise<number> {
  return client({ name: "stream-client" }).connectWith(stream, async (ctx) => {
    const response = await ctx.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    return response.protocolVersion;
  });
}

describe("serveStreams", () => {
  it("serves an in-memory message stream pair and resolves when the client disconnects", async () => {
    const { handler } = recordingHandler(async () => ({ stopReason: "end_turn", summary: "" }));
    const agent = createAcpAgent({ handler });
    const clientToAgent = new TransformStream<AnyMessage, AnyMessage>();
    const agentToClient = new TransformStream<AnyMessage, AnyMessage>();

    const served = serveStreams(agent, {
      readable: clientToAgent.readable,
      writable: agentToClient.writable,
    });
    const version = await initializeVia({
      readable: agentToClient.readable,
      writable: clientToAgent.writable,
    });

    expect(version).toBe(1);
    await clientToAgent.writable.close();
    await served;
  });
});

describe("serveStdio", () => {
  it("serves NDJSON byte streams and resolves when the input ends", async () => {
    const { handler } = recordingHandler(async () => ({ stopReason: "end_turn", summary: "" }));
    const agent = createAcpAgent({ handler });
    const toAgent = new TransformStream<Uint8Array, Uint8Array>();
    const fromAgent = new TransformStream<Uint8Array, Uint8Array>();

    const served = serveStdio(agent, { input: toAgent.readable, output: fromAgent.writable });
    const version = await initializeVia(ndJsonStream(toAgent.writable, fromAgent.readable));

    expect(version).toBe(1);
    await toAgent.writable.close();
    await served;
  });
});

describe("agent over the SDK in-memory pair", () => {
  it("answers initialize through withClient", async () => {
    const { handler } = recordingHandler(async () => ({ stopReason: "end_turn", summary: "" }));
    const agent = createAcpAgent({ handler });
    const version = await withClient(agent, async (ctx) => {
      const response = await ctx.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      return response.protocolVersion;
    });
    expect(version).toBe(1);
  });
});
