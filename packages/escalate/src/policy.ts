import { EscalationError } from "./errors.js";
import { API_KEY_AUTH, type CheckPolicyInput } from "./types.js";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches `value` against `pattern`, where `*` is the only wildcard and the match is whole-string. */
export function globMatch(pattern: string, value: string): boolean {
  const source = pattern.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}$`, "u").test(value);
}

/**
 * Throws POLICY_DENIED unless the provider and model are allowed and the api-key auth method
 * is permitted. An empty allow-list denies everything.
 */
export function checkPolicy(input: CheckPolicyInput): void {
  const { providerId, model, policy } = input;
  if (!policy.allowedProviders.includes(providerId)) {
    throw new EscalationError(
      "POLICY_DENIED",
      `provider "${providerId}" is not listed in policy.allowedProviders`,
    );
  }
  if (!policy.allowedModels.some((pattern) => globMatch(pattern, model))) {
    throw new EscalationError(
      "POLICY_DENIED",
      `model "${model}" is not allowed by policy.allowedModels`,
    );
  }
  if (!policy.authMethods.includes(API_KEY_AUTH)) {
    throw new EscalationError(
      "POLICY_DENIED",
      `policy.authMethods does not allow "${API_KEY_AUTH}"`,
    );
  }
}
