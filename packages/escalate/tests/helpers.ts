import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as z from "zod";
import type { EscalationRequest } from "../src/index.js";

export const API_KEY = "sk-test-SECRET-0123456789abcdef";

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

export type Handler = (req: RecordedRequest, res: ServerResponse) => void;

export interface FakeProvider {
  readonly baseUrl: string;
  readonly port: number;
  readonly requests: RecordedRequest[];
  setHandler(handler: Handler): void;
  close(): Promise<void>;
}

export function completionEnvelope(content: string): string {
  return JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  });
}

/** Responds 200 with the given message content. */
export function replyWith(content: string): Handler {
  return (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(completionEnvelope(content));
  };
}

export async function startFakeProvider(initial: Handler): Promise<FakeProvider> {
  const requests: RecordedRequest[] = [];
  let handler: Handler = initial;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded: RecordedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake provider did not bind a TCP port");
  }
  const { port } = address as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    setHandler(next: Handler): void {
      handler = next;
    },
    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export const FixSchema = z.object({
  answer: z.string(),
  confidence: z.number(),
});

export type Fix = z.infer<typeof FixSchema>;

/** A valid request against `provider`. Tests override the fields they vary. */
export function makeRequest(
  provider: { readonly baseUrl: string },
  overrides: Partial<EscalationRequest<Fix>> = {},
): EscalationRequest<Fix> {
  return {
    provider: { id: "hosted", baseUrl: provider.baseUrl, apiKey: API_KEY },
    model: "gpt-test",
    policy: {
      allowedProviders: ["hosted"],
      allowedModels: ["gpt-test"],
      authMethods: ["api-key"],
    },
    messages: [
      { role: "system", content: "Answer in JSON." },
      { role: "user", content: "Fix the off-by-one error in src/a.ts." },
    ],
    files: ["src/a.ts"],
    schema: FixSchema,
    description: "Fix one diagnostic",
    ...overrides,
  };
}
