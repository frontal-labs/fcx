import type * as z from "zod";

/** The only auth method this package implements: a bearer API key from the caller's environment. */
export const API_KEY_AUTH = "api-key";

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** Same shape as the `policy` block in plan section 5.3 (the escalation fields). */
export interface EscalationPolicy {
  readonly allowedProviders: readonly string[];
  /** Model ids. A `*` in an entry matches any run of characters. */
  readonly allowedModels: readonly string[];
  readonly authMethods: readonly string[];
}

/** Provider inputs passed in explicitly by the caller. The api key is never logged or summarised. */
export interface ProviderInput {
  readonly id: string;
  /** OpenAI-compatible base URL, e.g. `https://api.example.com/v1`. `/chat/completions` is appended. */
  readonly baseUrl: string;
  readonly apiKey: string;
}

export interface EscalationRequest<T> {
  readonly provider: ProviderInput;
  readonly model: string;
  readonly policy: EscalationPolicy;
  readonly messages: readonly ChatMessage[];
  /** File paths included in `messages`. Shown to the user for approval. */
  readonly files: readonly string[];
  /** Validates the model output. Also used to build the JSON-schema response format. */
  readonly schema: z.ZodType<T, unknown>;
  /** Short human-readable purpose, shown in the approval summary. */
  readonly description: string;
  /** Name for the JSON-schema response format. Defaults to `escalation_result`. */
  readonly schemaName?: string;
  /** Request timeout in milliseconds. Defaults to 60 000. */
  readonly timeoutMs?: number;
  /** Maximum response body size in bytes. Defaults to 1 MiB. */
  readonly maxResponseBytes?: number;
}

/** What the user sees before approving. Contains no credentials and no base URL. */
export interface EscalationSummary {
  readonly description: string;
  readonly provider: string;
  readonly model: string;
  readonly files: readonly string[];
  /** Approximate token count of the messages (about 4 characters per token). */
  readonly approxTokens: number;
}

/** Must resolve to `true` for the request to be sent. Any other value declines. */
export type ApprovalFn = (summary: EscalationSummary) => boolean | Promise<boolean>;

export interface EscalateOptions<T> {
  readonly request: EscalationRequest<T>;
  /** Required. There is no way to escalate without an approval callback. */
  readonly approve: ApprovalFn;
}

export interface EscalationResult<T> {
  /** The parsed and schema-validated model output. The caller must run its defense pipeline on it. */
  readonly value: T;
  readonly provider: string;
  readonly model: string;
}

export interface CheckPolicyInput {
  readonly providerId: string;
  readonly model: string;
  readonly policy: EscalationPolicy;
}
