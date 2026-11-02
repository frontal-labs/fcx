import * as z from "zod";
import { EscalationError } from "./errors.js";
import type { EscalationRequest } from "./types.js";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
export const DEFAULT_SCHEMA_NAME = "escalation_result";

/** Builds the chat-completions body: the caller's messages plus a JSON-schema response format. */
export function buildChatBody<T>(request: EscalationRequest<T>): string {
  const jsonSchema = z.toJSONSchema(request.schema);
  return JSON.stringify({
    model: request.model,
    messages: request.messages,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: request.schemaName ?? DEFAULT_SCHEMA_NAME,
        schema: jsonSchema,
      },
    },
  });
}

export function chatEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function timeoutError(timeoutMs: number): EscalationError {
  return new EscalationError("TIMEOUT", `provider did not respond within ${timeoutMs} ms`);
}

function badResponse(detail: string): EscalationError {
  return new EscalationError("BAD_RESPONSE", detail);
}

/** Maps a fetch or stream failure to TIMEOUT when our signal fired, otherwise HTTP_ERROR. */
function classifyTransportError(signal: AbortSignal, timeoutMs: number): EscalationError {
  if (signal.aborted) {
    return timeoutError(timeoutMs);
  }
  return new EscalationError("HTTP_ERROR", "request to provider failed (network error)");
}

/** Reads the body with a hard byte limit. The limit is checked against content-length and while streaming. */
async function readBounded(res: Response, maxBytes: number): Promise<string> {
  const declared = res.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw badResponse(`response exceeds the ${maxBytes} byte limit`);
  }
  if (res.body === null) {
    return "";
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw badResponse(`response exceeds the ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function cancelBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/**
 * POSTs the chat request and returns the raw response text. The api key goes only in the
 * Authorization header. Redirects are refused so the key is never sent to another host.
 */
export async function postChatCompletion<T>(
  request: EscalationRequest<T>,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(chatEndpoint(request.provider.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${request.provider.apiKey}`,
      },
      body: buildChatBody(request),
      redirect: "error",
      signal,
    });
  } catch {
    throw classifyTransportError(signal, timeoutMs);
  }
  try {
    if (!res.ok) {
      await cancelBody(res);
      throw new EscalationError("HTTP_ERROR", `provider responded with HTTP ${res.status}`);
    }
    return await readBounded(res, maxResponseBytes);
  } catch (error) {
    if (error instanceof EscalationError) {
      throw error;
    }
    throw classifyTransportError(signal, timeoutMs);
  }
}
