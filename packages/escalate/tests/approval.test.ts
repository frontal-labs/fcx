import { describe, expect, it, vi } from "vitest";
import { type EscalationSummary, escalate, summarizeRequest } from "../src/index.js";
import {
  API_KEY,
  type FakeProvider,
  makeRequest,
  replyWith,
  startFakeProvider,
} from "./helpers.js";

describe("approval", () => {
  let provider: FakeProvider;

  it("passes a summary to approve before sending, then sends once when approved", async () => {
    provider = await startFakeProvider(replyWith('{"answer":"fixed","confidence":0.8}'));
    try {
      const seen: EscalationSummary[] = [];
      const approve = vi.fn(async (summary: EscalationSummary) => {
        seen.push(summary);
        expect(provider.requests).toHaveLength(0);
        return true;
      });
      const request = makeRequest(provider, {
        messages: [{ role: "user", content: "x".repeat(400) }],
        files: ["src/a.ts", "src/b.ts"],
        description: "Fix two files",
      });
      const result = await escalate({ request, approve });

      expect(result.value).toEqual({ answer: "fixed", confidence: 0.8 });
      expect(approve).toHaveBeenCalledTimes(1);
      expect(seen[0]).toEqual({
        description: "Fix two files",
        provider: "hosted",
        model: "gpt-test",
        files: ["src/a.ts", "src/b.ts"],
        approxTokens: 100,
      });
      expect(provider.requests).toHaveLength(1);
    } finally {
      await provider.close();
    }
  });

  it("performs zero requests when approval is declined", async () => {
    provider = await startFakeProvider(replyWith('{"answer":"x","confidence":1}'));
    try {
      const approve = vi.fn(() => false);
      await expect(escalate({ request: makeRequest(provider), approve })).rejects.toMatchObject({
        code: "APPROVAL_DECLINED",
      });
      expect(approve).toHaveBeenCalledTimes(1);
      expect(provider.requests).toHaveLength(0);
    } finally {
      await provider.close();
    }
  });

  it("declines on any value other than the literal true", async () => {
    provider = await startFakeProvider(replyWith('{"answer":"x","confidence":1}'));
    try {
      for (const value of ["yes", 1, {}, undefined, null]) {
        const approve = vi.fn(() => value as unknown as boolean);
        await expect(escalate({ request: makeRequest(provider), approve })).rejects.toMatchObject({
          code: "APPROVAL_DECLINED",
        });
      }
      expect(provider.requests).toHaveLength(0);
    } finally {
      await provider.close();
    }
  });

  it("declines with zero requests when approve throws", async () => {
    provider = await startFakeProvider(replyWith('{"answer":"x","confidence":1}'));
    try {
      const approve = vi.fn(async (): Promise<boolean> => {
        throw new Error("prompt crashed");
      });
      await expect(escalate({ request: makeRequest(provider), approve })).rejects.toMatchObject({
        code: "APPROVAL_DECLINED",
      });
      expect(provider.requests).toHaveLength(0);
    } finally {
      await provider.close();
    }
  });

  it("has no way to skip approval: a missing callback declines with zero requests", async () => {
    provider = await startFakeProvider(replyWith('{"answer":"x","confidence":1}'));
    try {
      const request = makeRequest(provider);
      // @ts-expect-error approve is required by the type; this exercises the runtime guard.
      await expect(escalate({ request })).rejects.toMatchObject({ code: "APPROVAL_DECLINED" });
      expect(provider.requests).toHaveLength(0);
    } finally {
      await provider.close();
    }
  });

  it("summary never contains the api key or the base URL", async () => {
    provider = await startFakeProvider(replyWith('{"answer":"x","confidence":1}'));
    try {
      const summary = summarizeRequest(makeRequest(provider));
      const text = JSON.stringify(summary);
      expect(text).not.toContain(API_KEY);
      expect(text).not.toContain(provider.baseUrl);
      expect(Object.keys(summary).sort()).toEqual(
        ["approxTokens", "description", "files", "model", "provider"].sort(),
      );
    } finally {
      await provider.close();
    }
  });

  it("approxTokens rounds up at four characters per token", () => {
    const summary = summarizeRequest(
      makeRequest(
        { baseUrl: "http://127.0.0.1:1/v1" },
        {
          messages: [
            { role: "user", content: "abcde" },
            { role: "system", content: "fgh" },
          ],
        },
      ),
    );
    expect(summary.approxTokens).toBe(2);
  });
});
