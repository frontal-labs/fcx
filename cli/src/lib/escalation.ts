import { readFileSync } from "node:fs";
import { relative } from "node:path";
import type { Edit } from "@fcx/apply";
import type { EffectivePolicy, Env, ProjectConfig } from "@fcx/config";
import type { LayerOutcome } from "@fcx/defense";
import {
  type ChatMessage,
  type EscalateOptions,
  type EscalationPolicy,
  type EscalationRequest,
  type EscalationResult,
  type EscalationSummary,
  type ProviderInput,
  checkPolicy,
  escalate,
  summarizeRequest,
} from "@fcx/escalate";
import { FIX_DIAGNOSTIC_SYSTEM, type FixOutput, FixOutputSchema, verifyEdits } from "@fcx/recipes";
import { type Checker, type Diagnostic, errorsOnly } from "@fcx/verify";

/** Injectable hosted call. The real one is `escalate` from @fcx/escalate; tests pass a fake. */
export type EscalateFn = (
  options: EscalateOptions<FixOutput>,
) => Promise<EscalationResult<FixOutput>>;

export interface EscalationSetup {
  readonly provider: ProviderInput;
  readonly model: string;
  readonly policy: EscalationPolicy;
  /** Shown before anything is sent. Returns true only when the user says yes. */
  readonly offer: (summary: EscalationSummary) => Promise<boolean>;
  /** Defaults to the real `escalate`. */
  readonly escalate?: EscalateFn;
}

export type EscalationOutcome =
  | { status: "declined"; summary: EscalationSummary }
  | { status: "policy-denied"; message: string }
  | { status: "failed"; message: string }
  | { status: "rejected"; feedback: string; layers: LayerOutcome[] }
  | {
      status: "verified";
      edits: Edit[];
      /** The exact text the hosted answer was verified against. Applying must use this. */
      baseText: string;
      layers: LayerOutcome[];
      provider: string;
      model: string;
    };

export interface EscalationInput {
  setup: EscalationSetup;
  checker: Checker;
  workspace: string;
  /** Absolute path of the file that has the diagnostic. */
  file: string;
  target: Diagnostic;
}

/**
 * Builds the hosted escalation setup from the config, or returns undefined when escalation cannot run:
 * the provider is not configured, or its credentials are missing from the environment. The API key is
 * read here and goes only into the request, never into a report.
 */
export function escalationSetupFor(
  input: { projectConfig: ProjectConfig; policy: EffectivePolicy; env: Env },
  offer: EscalationSetup["offer"],
): EscalationSetup | undefined {
  const runtime = input.projectConfig.runtime;
  const providerId = runtime?.default_provider;
  if (!providerId) return undefined;
  const provider = runtime?.providers?.[providerId];
  const model = provider?.default_model;
  if (provider?.enabled === false || !model) return undefined;
  const apiKey = input.env.FRONTAL_API_KEY;
  const baseUrl = input.env.FRONTAL_BASE_URL;
  if (!apiKey || !baseUrl) return undefined;
  return {
    provider: { id: providerId, baseUrl, apiKey },
    model,
    policy: {
      allowedProviders: input.policy.allowedProviders,
      allowedModels: input.policy.allowedModels,
      authMethods: input.policy.authMethods,
    },
    offer,
  };
}

/** The request sends the target file and the diagnostic only, with the same schema as the local recipe. */
function buildRequest(
  setup: EscalationSetup,
  input: EscalationInput,
  text: string,
): EscalationRequest<FixOutput> {
  const rel = relative(input.workspace, input.file).split("\\").join("/");
  const { target } = input;
  const numbered = text
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(4)}| ${line}`)
    .join("\n");
  const user = [
    `Allowed files: ${rel}`,
    `Diagnostic: ${rel}:${target.line}:${target.column} TS${target.code} ${target.message}`,
    "",
    `File ${rel}:`,
    numbered,
  ].join("\n");
  const messages: ChatMessage[] = [
    { role: "system", content: FIX_DIAGNOSTIC_SYSTEM },
    { role: "user", content: user },
  ];
  return {
    provider: setup.provider,
    model: setup.model,
    policy: setup.policy,
    messages,
    files: [rel],
    schema: FixOutputSchema,
    description: `fix TS${target.code} at ${rel}:${target.line}`,
    schemaName: "fix_output",
  };
}

/** Removes every occurrence of the api key, so an error message can never leak it. */
function redact(message: string, apiKey: string): string {
  return message.split(apiKey).join("[redacted]");
}

/**
 * Offers a hosted escalation for an abstained fix. Order: policy check, offer (the user's yes is the approval),
 * then one hosted call. The hosted answer is only proposed edits. It goes through the same
 * constrain, anchor and verify layers as the local recipe before it can count as verified.
 */
export async function escalateAbstained(input: EscalationInput): Promise<EscalationOutcome> {
  const { setup, checker, workspace, file, target } = input;
  const text = readFileSync(file, "utf-8");
  const request = buildRequest(setup, input, text);
  const summary = summarizeRequest(request);

  // Policy first: a provider the policy forbids is never offered to the user.
  try {
    checkPolicy({ providerId: setup.provider.id, model: setup.model, policy: setup.policy });
  } catch (error) {
    return { status: "policy-denied", message: redact(messageOf(error), setup.provider.apiKey) };
  }

  if (!(await setup.offer(summary))) {
    return { status: "declined", summary };
  }

  let result: EscalationResult<FixOutput>;
  try {
    // The user already said yes above, so the escalate approval step is granted here.
    result = await (setup.escalate ?? escalate)({ request, approve: () => true });
  } catch (error) {
    return { status: "failed", message: redact(messageOf(error), setup.provider.apiKey) };
  }

  const verdict = verifyEdits({
    edits: result.value.edits,
    workspace,
    allowedFiles: [file],
    primaryFile: file,
    text,
    checker,
    target,
    originalErrors: errorsOnly(checker.diagnostics(file)),
    readFile: (path) => readFileSync(path, "utf-8"),
  });
  if (!verdict.pass) {
    return { status: "rejected", feedback: verdict.feedback, layers: verdict.layers };
  }
  return {
    status: "verified",
    edits: result.value.edits,
    baseText: text,
    layers: verdict.layers,
    provider: result.provider,
    model: result.model,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Decides whether an abstained fix may offer a hosted escalation in this run. Off when --no-escalate is
 * given, when fc.escalation.enabled is false, when there is no terminal to ask at, or when the provider
 * is not configured.
 */
export function escalationOptionFor(input: {
  noEscalate: boolean;
  enabled: boolean;
  isTTY: boolean;
  projectConfig: ProjectConfig;
  policy: EffectivePolicy;
  env: Env;
  offer: EscalationSetup["offer"];
}): EscalationSetup | undefined {
  if (input.noEscalate || !input.enabled || !input.isTTY) return undefined;
  return escalationSetupFor(input, input.offer);
}
