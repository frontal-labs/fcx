import type * as z from "zod";
import { EscalationError } from "./errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pulls `choices[0].message.content` out of a chat-completions envelope. */
function extractContent(envelope: unknown): string {
  if (!isRecord(envelope) || !Array.isArray(envelope.choices)) {
    throw new EscalationError("BAD_RESPONSE", "response has no choices array");
  }
  const first: unknown = envelope.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) {
    throw new EscalationError("BAD_RESPONSE", "response has no message");
  }
  if (typeof first.message.content !== "string") {
    throw new EscalationError("BAD_RESPONSE", "response message has no text content");
  }
  return first.message.content;
}

/**
 * Parses the envelope, then the model's JSON content, then validates it with the caller's schema.
 * Malformed JSON gives BAD_RESPONSE and a schema failure gives SCHEMA_MISMATCH. Zod issues are
 * not included in the error, since they can echo model output.
 */
export function parseChatResponse<T>(bodyText: string, schema: z.ZodType<T, unknown>): T {
  let envelope: unknown;
  try {
    envelope = JSON.parse(bodyText);
  } catch {
    throw new EscalationError("BAD_RESPONSE", "response body is not valid JSON");
  }
  const content = extractContent(envelope);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new EscalationError("BAD_RESPONSE", "model output is not valid JSON");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new EscalationError(
      "SCHEMA_MISMATCH",
      "model output does not match the requested schema",
    );
  }
  return result.data;
}
