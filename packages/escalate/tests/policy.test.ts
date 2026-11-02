import { describe, expect, it, vi } from "vitest";
import { EscalationError, checkPolicy, escalate } from "../src/index.js";
import { globMatch } from "../src/policy.js";
import { type FakeProvider, makeRequest, replyWith, startFakeProvider } from "./helpers.js";

const okPolicy = {
  allowedProviders: ["hosted"],
  allowedModels: ["gpt-test"],
  authMethods: ["api-key"],
};

describe("globMatch", () => {
  it("matches exact strings and treats * as a wildcard", () => {
    expect(globMatch("gpt-test", "gpt-test")).toBe(true);
    expect(globMatch("gpt-test", "gpt-test-2")).toBe(false);
    expect(globMatch("*", "anything/at-all")).toBe(true);
    expect(globMatch("ggml/*", "ggml/qwen")).toBe(true);
    expect(globMatch("ggml/*", "other/qwen")).toBe(false);
  });

  it("treats regex metacharacters literally", () => {
    expect(globMatch("a.b", "a.b")).toBe(true);
    expect(globMatch("a.b", "axb")).toBe(false);
    expect(globMatch("(x)+", "xxx")).toBe(false);
  });

  it("matches the whole string only", () => {
    expect(globMatch("gpt", "gpt-test")).toBe(false);
    expect(globMatch("test", "gpt-test")).toBe(false);
  });
});

describe("checkPolicy", () => {
  it("accepts an allowed provider, model and auth method", () => {
    expect(() =>
      checkPolicy({ providerId: "hosted", model: "gpt-test", policy: okPolicy }),
    ).not.toThrow();
  });

  it("denies a provider that is not in allowedProviders", () => {
    try {
      checkPolicy({ providerId: "other", model: "gpt-test", policy: okPolicy });
      expect.fail("expected POLICY_DENIED");
    } catch (error) {
      expect(error).toBeInstanceOf(EscalationError);
      expect((error as EscalationError).code).toBe("POLICY_DENIED");
    }
  });

  it("denies a model that is not in allowedModels", () => {
    expect(() =>
      checkPolicy({ providerId: "hosted", model: "gpt-other", policy: okPolicy }),
    ).toThrow(EscalationError);
  });

  it("denies when authMethods does not include api-key", () => {
    expect(() =>
      checkPolicy({
        providerId: "hosted",
        model: "gpt-test",
        policy: { ...okPolicy, authMethods: ["oauth"] },
      }),
    ).toThrow(/authMethods/);
  });

  it("denies everything when the allow-lists are empty", () => {
    expect(() =>
      checkPolicy({
        providerId: "hosted",
        model: "gpt-test",
        policy: { allowedProviders: [], allowedModels: [], authMethods: [] },
      }),
    ).toThrow(EscalationError);
  });

  it("accepts a * glob in allowedModels", () => {
    expect(() =>
      checkPolicy({
        providerId: "hosted",
        model: "any/model-id",
        policy: { ...okPolicy, allowedModels: ["*"] },
      }),
    ).not.toThrow();
  });
});

describe("escalate policy enforcement", () => {
  let provider: FakeProvider;

  it("denies a disallowed provider with zero requests and no approval prompt", async () => {
    provider = await startFakeProvider(replyWith("{}"));
    try {
      const approve = vi.fn(() => true);
      const request = makeRequest(provider, {
        policy: { ...okPolicy, allowedProviders: ["someone-else"] },
      });
      await expect(escalate({ request, approve })).rejects.toMatchObject({
        code: "POLICY_DENIED",
      });
      expect(approve).not.toHaveBeenCalled();
      expect(provider.requests).toHaveLength(0);
    } finally {
      await provider.close();
    }
  });

  it("denies a disallowed model with zero requests", async () => {
    provider = await startFakeProvider(replyWith("{}"));
    try {
      const approve = vi.fn(() => true);
      const request = makeRequest(provider, { model: "gpt-expensive" });
      await expect(escalate({ request, approve })).rejects.toMatchObject({
        code: "POLICY_DENIED",
      });
      expect(approve).not.toHaveBeenCalled();
      expect(provider.requests).toHaveLength(0);
    } finally {
      await provider.close();
    }
  });

  it("denies when api-key auth is not permitted, with zero requests", async () => {
    provider = await startFakeProvider(replyWith("{}"));
    try {
      const approve = vi.fn(() => true);
      const request = makeRequest(provider, {
        policy: { ...okPolicy, authMethods: [] },
      });
      await expect(escalate({ request, approve })).rejects.toMatchObject({
        code: "POLICY_DENIED",
      });
      expect(provider.requests).toHaveLength(0);
    } finally {
      await provider.close();
    }
  });

  it("allows any model through a * glob, end to end", async () => {
    provider = await startFakeProvider(replyWith('{"answer":"ok","confidence":0.9}'));
    try {
      const request = makeRequest(provider, {
        model: "vendor/some-model-7b",
        policy: { ...okPolicy, allowedModels: ["*"] },
      });
      const result = await escalate({ request, approve: () => true });
      expect(result.value).toEqual({ answer: "ok", confidence: 0.9 });
      expect(result.model).toBe("vendor/some-model-7b");
      expect(provider.requests).toHaveLength(1);
    } finally {
      await provider.close();
    }
  });
});
