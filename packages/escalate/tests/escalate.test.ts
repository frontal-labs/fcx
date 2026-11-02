import { describe, expect, it } from "vitest";
import * as z from "zod";
import { EscalationError, type EscalationErrorCode, escalate } from "../src/index.js";
import { DEFAULT_TIMEOUT_MS } from "../src/request.js";
import { parseChatResponse } from "../src/response.js";
import {
  API_KEY,
  type FakeProvider,
  FixSchema,
  type Handler,
  completionEnvelope,
  makeRequest,
  replyWith,
  startFakeProvider,
} from "./helpers.js";

const approve = () => true;

async function expectCode(
  promise: Promise<unknown>,
  code: EscalationErrorCode,
): Promise<EscalationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EscalationError);
    const typed = error as EscalationError;
    expect(typed.code).toBe(code);
    return typed;
  }
  throw new Error(`expected ${code}`);
}

describe("happy path and request shape", () => {
  it("POSTs to /chat/completions with bearer auth, messages and a JSON-schema response format", async () => {
    const provider = await startFakeProvider(replyWith('{"answer":"fixed","confidence":0.5}'));
    try {
      const result = await escalate({ request: makeRequest(provider), approve });

      expect(result).toEqual({
        value: { answer: "fixed", confidence: 0.5 },
        provider: "hosted",
        model: "gpt-test",
      });
      expect(provider.requests).toHaveLength(1);
      const [req] = provider.requests;
      expect(req?.method).toBe("POST");
      expect(req?.url).toBe("/v1/chat/completions");
      expect(req?.headers.authorization).toBe(`Bearer ${API_KEY}`);
      expect(req?.headers["content-type"]).toBe("application/json");

      const body = JSON.parse(req?.body ?? "{}") as Record<string, unknown>;
      expect(body.model).toBe("gpt-test");
      expect(body.messages).toEqual([
        { role: "system", content: "Answer in JSON." },
        { role: "user", content: "Fix the off-by-one error in src/a.ts." },
      ]);
      const format = body.response_format as {
        type: string;
        json_schema: { name: string; schema: { properties: Record<string, unknown> } };
      };
      expect(format.type).toBe("json_schema");
      expect(format.json_schema.name).toBe("escalation_result");
      expect(Object.keys(format.json_schema.schema.properties).sort()).toEqual([
        "answer",
        "confidence",
      ]);
    } finally {
      await provider.close();
    }
  });

  it("uses a custom schemaName and strips trailing slashes from baseUrl", async () => {
    const provider = await startFakeProvider(replyWith('{"answer":"a","confidence":1}'));
    try {
      const request = makeRequest(provider, {
        schemaName: "fix_result",
        provider: { id: "hosted", baseUrl: `${provider.baseUrl}//`, apiKey: API_KEY },
      });
      await escalate({ request, approve });
      const body = JSON.parse(provider.requests[0]?.body ?? "{}") as {
        response_format: { json_schema: { name: string } };
      };
      expect(body.response_format.json_schema.name).toBe("fix_result");
      expect(provider.requests[0]?.url).toBe("/v1/chat/completions");
    } finally {
      await provider.close();
    }
  });

  it("does not put the api key in the request body", async () => {
    const provider = await startFakeProvider(replyWith('{"answer":"a","confidence":1}'));
    try {
      await escalate({ request: makeRequest(provider), approve });
      expect(provider.requests[0]?.body).not.toContain(API_KEY);
    } finally {
      await provider.close();
    }
  });

  it("exposes DEFAULT_TIMEOUT_MS as 60 seconds", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(60_000);
  });
});

describe("error codes", () => {
  it("non-2xx status gives HTTP_ERROR, and redirects are not followed", async () => {
    const provider = await startFakeProvider((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal failure");
    });
    try {
      await expectCode(escalate({ request: makeRequest(provider), approve }), "HTTP_ERROR");
    } finally {
      await provider.close();
    }
  });

  it("401 gives HTTP_ERROR with the status in the message", async () => {
    const provider = await startFakeProvider((_req, res) => {
      res.writeHead(401);
      res.end();
    });
    try {
      const error = await expectCode(
        escalate({ request: makeRequest(provider), approve }),
        "HTTP_ERROR",
      );
      expect(error.message).toContain("401");
    } finally {
      await provider.close();
    }
  });

  it("refuses a redirect, so the api key is never sent to the target host", async () => {
    const target = await startFakeProvider(replyWith('{"answer":"a","confidence":1}'));
    const provider = await startFakeProvider((_req, res) => {
      res.writeHead(302, { location: `${target.baseUrl}/chat/completions` });
      res.end();
    });
    try {
      await expectCode(escalate({ request: makeRequest(provider), approve }), "HTTP_ERROR");
      expect(target.requests).toHaveLength(0);
    } finally {
      await provider.close();
      await target.close();
    }
  });

  it("a refused connection gives HTTP_ERROR", async () => {
    const closed = await startFakeProvider(replyWith("{}"));
    const baseUrl = closed.baseUrl;
    await closed.close();
    const request = makeRequest({ baseUrl });
    await expectCode(escalate({ request, approve }), "HTTP_ERROR");
  });

  it("a hanging provider gives TIMEOUT once timeoutMs passes", async () => {
    const provider = await startFakeProvider(() => {
      // Never respond. The client's timeout must fire.
    });
    try {
      const started = Date.now();
      await expectCode(
        escalate({ request: makeRequest(provider, { timeoutMs: 150 }), approve }),
        "TIMEOUT",
      );
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await provider.close();
    }
  });

  it("a body that stalls mid-stream gives TIMEOUT", async () => {
    const provider = await startFakeProvider((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"choices":[');
      // Hold the stream open with no more data.
    });
    try {
      await expectCode(
        escalate({ request: makeRequest(provider, { timeoutMs: 150 }), approve }),
        "TIMEOUT",
      );
    } finally {
      await provider.close();
    }
  });

  it("a non-JSON envelope gives BAD_RESPONSE", async () => {
    const provider = await startFakeProvider(replyWith("never mind"));
    try {
      await expectCode(escalate({ request: makeRequest(provider), approve }), "BAD_RESPONSE");
    } finally {
      await provider.close();
    }
  });

  it("an envelope without choices gives BAD_RESPONSE", async () => {
    const provider = await startFakeProvider((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ error: "nope" }));
    });
    try {
      await expectCode(escalate({ request: makeRequest(provider), approve }), "BAD_RESPONSE");
    } finally {
      await provider.close();
    }
  });

  it("non-JSON model content gives BAD_RESPONSE, not SCHEMA_MISMATCH", async () => {
    const provider = await startFakeProvider(replyWith("Sure! Here is the fix: ..."));
    try {
      await expectCode(escalate({ request: makeRequest(provider), approve }), "BAD_RESPONSE");
    } finally {
      await provider.close();
    }
  });

  it("content that is JSON but fails the schema gives SCHEMA_MISMATCH", async () => {
    const provider = await startFakeProvider(replyWith('{"answer":42}'));
    try {
      await expectCode(escalate({ request: makeRequest(provider), approve }), "SCHEMA_MISMATCH");
    } finally {
      await provider.close();
    }
  });

  it("a response over maxResponseBytes gives BAD_RESPONSE", async () => {
    const provider = await startFakeProvider(
      replyWith(`{"answer":"${"x".repeat(2_000)}","confidence":1}`),
    );
    try {
      await expectCode(
        escalate({ request: makeRequest(provider, { maxResponseBytes: 512 }), approve }),
        "BAD_RESPONSE",
      );
    } finally {
      await provider.close();
    }
  });

  it("a chunked response over maxResponseBytes (no content-length) gives BAD_RESPONSE", async () => {
    const provider = await startFakeProvider((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      for (let i = 0; i < 20; i += 1) {
        res.write("y".repeat(200));
      }
      res.end();
    });
    try {
      await expectCode(
        escalate({ request: makeRequest(provider, { maxResponseBytes: 1_000 }), approve }),
        "BAD_RESPONSE",
      );
    } finally {
      await provider.close();
    }
  });

  it("every error code is a stable string on EscalationError", async () => {
    const provider = await startFakeProvider(replyWith('{"answer":1}'));
    try {
      const error = await expectCode(
        escalate({ request: makeRequest(provider), approve }),
        "SCHEMA_MISMATCH",
      );
      expect(error.name).toBe("EscalationError");
      expect(error).toBeInstanceOf(Error);
    } finally {
      await provider.close();
    }
  });
});

describe("parseChatResponse", () => {
  it("returns the validated value for well-formed content", () => {
    expect(
      parseChatResponse(completionEnvelope('{"answer":"a","confidence":0.1}'), FixSchema),
    ).toEqual({
      answer: "a",
      confidence: 0.1,
    });
  });

  it("rejects a message without string content", () => {
    const body = JSON.stringify({ choices: [{ message: { content: null } }] });
    expect(() => parseChatResponse(body, FixSchema)).toThrow(EscalationError);
  });

  it("rejects an empty choices array", () => {
    expect(() => parseChatResponse('{"choices":[]}', FixSchema)).toThrow(/no message/);
  });

  it("does not put zod issues or model output in the error message", () => {
    const secretish = "model-said-this-secret-value";
    try {
      parseChatResponse(completionEnvelope(JSON.stringify({ answer: secretish })), FixSchema);
      expect.fail("expected SCHEMA_MISMATCH");
    } catch (error) {
      expect((error as EscalationError).code).toBe("SCHEMA_MISMATCH");
      expect((error as Error).message).not.toContain(secretish);
    }
  });

  it("works with a schema that has a transform, returning the output type", () => {
    const schema = z.object({ n: z.string() }).transform((v) => Number(v.n));
    expect(parseChatResponse(completionEnvelope('{"n":"7"}'), schema)).toBe(7);
  });
});

describe("api key never leaks", () => {
  const scenarios: Array<{ name: string; handler: Handler; code: EscalationErrorCode }> = [
    {
      name: "HTTP 500 that echoes the key back",
      handler: (req, res) => {
        res.writeHead(500);
        res.end(`bad key ${req.headers.authorization ?? ""}`);
      },
      code: "HTTP_ERROR",
    },
    {
      name: "malformed envelope that echoes the key",
      handler: (req, res) => {
        res.writeHead(200);
        res.end(`not json ${req.headers.authorization ?? ""}`);
      },
      code: "BAD_RESPONSE",
    },
    {
      name: "schema mismatch that echoes the key in content",
      handler: (_req, res) => {
        res.writeHead(200);
        res.end(completionEnvelope(JSON.stringify({ answer: API_KEY })));
      },
      code: "SCHEMA_MISMATCH",
    },
    {
      name: "oversized response with the key in it",
      handler: (_req, res) => {
        res.writeHead(200);
        res.end(`${API_KEY}${"z".repeat(5_000)}`);
      },
      code: "BAD_RESPONSE",
    },
  ];

  for (const scenario of scenarios) {
    it(`keeps the key out of the error and the summary: ${scenario.name}`, async () => {
      const provider = await startFakeProvider(scenario.handler);
      try {
        const request = makeRequest(provider, { maxResponseBytes: 1_000 });
        const error = await expectCode(escalate({ request, approve }), scenario.code);
        expect(error.message).not.toContain(API_KEY);
        expect(JSON.stringify(error)).not.toContain(API_KEY);
        expect(String(error)).not.toContain(API_KEY);
        expect(Object.getOwnPropertyNames(error)).not.toContain("cause");
      } finally {
        await provider.close();
      }
    });
  }

  it("keeps the key out of the approval summary", async () => {
    const provider = await startFakeProvider(replyWith('{"answer":"a","confidence":1}'));
    try {
      let shown = "";
      await escalate({
        request: makeRequest(provider),
        approve: (summary) => {
          shown = JSON.stringify(summary);
          return true;
        },
      });
      expect(shown).not.toContain(API_KEY);
    } finally {
      await provider.close();
    }
  });

  it("keeps the key out of the error for a policy denial", async () => {
    const provider = await startFakeProvider(replyWith("{}"));
    try {
      const request = makeRequest(provider, { model: "forbidden" });
      const error = await expectCode(escalate({ request, approve }), "POLICY_DENIED");
      expect(error.message).not.toContain(API_KEY);
    } finally {
      await provider.close();
    }
  });
});

describe("input validation (no network)", () => {
  it("rejects an empty api key with a TypeError and zero requests", async () => {
    const provider = await startFakeProvider(replyWith("{}"));
    try {
      const request = makeRequest(provider, {
        provider: { id: "hosted", baseUrl: provider.baseUrl, apiKey: "" },
      });
      await expect(escalate({ request, approve })).rejects.toBeInstanceOf(TypeError);
      expect(provider.requests).toHaveLength(0);
    } finally {
      await provider.close();
    }
  });

  it("rejects a non-http baseUrl with a TypeError and no key in the message", async () => {
    const request = makeRequest(
      { baseUrl: "ftp://example.test" },
      {
        provider: { id: "hosted", baseUrl: "ftp://example.test", apiKey: API_KEY },
      },
    );
    const error = await escalate({ request, approve }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).not.toContain(API_KEY);
  });

  it("rejects a non-positive timeout and an empty message list", async () => {
    const provider = await startFakeProvider(replyWith("{}"));
    try {
      await expect(
        escalate({ request: makeRequest(provider, { timeoutMs: 0 }), approve }),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        escalate({ request: makeRequest(provider, { messages: [] }), approve }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(provider.requests).toHaveLength(0);
    } finally {
      await provider.close();
    }
  });
});
