import { EscalationError } from "./errors.js";
import type { ApprovalFn, EscalationRequest, EscalationSummary } from "./types.js";

const CHARS_PER_TOKEN = 4;

/** Builds the approval summary. It deliberately carries no api key and no base URL. */
export function summarizeRequest<T>(request: EscalationRequest<T>): EscalationSummary {
  const chars = request.messages.reduce((total, message) => total + message.content.length, 0);
  return {
    description: request.description,
    provider: request.provider.id,
    model: request.model,
    files: [...request.files],
    approxTokens: Math.ceil(chars / CHARS_PER_TOKEN),
  };
}

/**
 * Asks the user. Only the literal `true` grants approval. A missing callback, a throwing
 * callback or any other value declines, and the caller must not send anything.
 */
export async function requestApproval(
  approve: ApprovalFn,
  summary: EscalationSummary,
): Promise<void> {
  if (typeof approve !== "function") {
    throw new EscalationError("APPROVAL_DECLINED", "no approval callback; nothing was sent");
  }
  let decision: unknown;
  try {
    decision = await approve(summary);
  } catch {
    throw new EscalationError("APPROVAL_DECLINED", "approval callback failed; nothing was sent");
  }
  if (decision !== true) {
    throw new EscalationError("APPROVAL_DECLINED", "approval was not granted; nothing was sent");
  }
}
