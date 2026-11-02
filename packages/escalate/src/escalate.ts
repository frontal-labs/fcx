import { requestApproval, summarizeRequest } from "./approval.js";
import { checkPolicy } from "./policy.js";
import { DEFAULT_MAX_RESPONSE_BYTES, DEFAULT_TIMEOUT_MS, postChatCompletion } from "./request.js";
import { parseChatResponse } from "./response.js";
import type { EscalateOptions, EscalationRequest, EscalationResult } from "./types.js";

function assertInputs<T>(request: EscalationRequest<T>): void {
  if (typeof request.provider.apiKey !== "string" || request.provider.apiKey.length === 0) {
    throw new TypeError("provider.apiKey must be a non-empty string");
  }
  try {
    const url = new URL(request.provider.baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new TypeError("provider.baseUrl must use http or https");
    }
  } catch {
    throw new TypeError("provider.baseUrl is not a valid http(s) URL");
  }
  if (request.messages.length === 0) {
    throw new TypeError("messages must not be empty");
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive finite number");
  }
  const maxBytes = request.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxResponseBytes must be a positive integer");
  }
}

/**
 * Escalates one task to a hosted OpenAI-compatible model.
 *
 * Order: input checks, policy (no network), approval (no network), then one POST.
 * Nothing is sent unless `approve` resolves to `true`. The returned value has only been
 * schema-validated. The caller must run its defense pipeline on it.
 */
export async function escalate<T>(options: EscalateOptions<T>): Promise<EscalationResult<T>> {
  const { request, approve } = options;
  assertInputs(request);
  checkPolicy({
    providerId: request.provider.id,
    model: request.model,
    policy: request.policy,
  });
  await requestApproval(approve, summarizeRequest(request));
  const text = await postChatCompletion(
    request,
    request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    request.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  );
  const value = parseChatResponse(text, request.schema);
  return { value, provider: request.provider.id, model: request.model };
}
