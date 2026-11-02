export const ESCALATION_ERROR_CODES = [
  "POLICY_DENIED",
  "APPROVAL_DECLINED",
  "HTTP_ERROR",
  "TIMEOUT",
  "BAD_RESPONSE",
  "SCHEMA_MISMATCH",
] as const;

export type EscalationErrorCode = (typeof ESCALATION_ERROR_CODES)[number];

/**
 * Typed escalation failure. Messages are fixed strings built by this package and never
 * include the api key, the response body or the zod issues. No `cause` is attached.
 */
export class EscalationError extends Error {
  readonly code: EscalationErrorCode;

  constructor(code: EscalationErrorCode, message: string) {
    super(message);
    this.name = "EscalationError";
    this.code = code;
  }
}
