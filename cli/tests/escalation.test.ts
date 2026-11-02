import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EscalateOptions, EscalationResult, EscalationSummary } from "@fcx/escalate";
import { openMemory } from "@fcx/memory";
import type { FixOutput } from "@fcx/recipes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/app.js";
import { parseGlobalArgs } from "../src/args.js";
import { type FixCommandOptions, exitCodeFor, runFixCommand } from "../src/commands/fix.js";
import {
  type EscalationSetup,
  escalationOptionFor,
  escalationSetupFor,
} from "../src/lib/escalation.js";
import { memoryPathFor, undoRootFor } from "../src/lib/repo.js";
import {
  BREAKING_EDIT,
  GOOD_EDIT,
  SOURCE,
  type Sandbox,
  captureLog,
  makeSandbox,
  scriptedModel,
} from "./support.js";

const API_KEY = "sk-test-secret-value-123";
const PROVIDER = { id: "frontal", baseUrl: "https://escalation.invalid/v1", apiKey: API_KEY };
const MODEL = "frontal-fix-1";
const POLICY = {
  allowedProviders: ["frontal"],
  allowedModels: ["frontal-*"],
  authMethods: ["api-key"],
};

/** Fake hosted call: records every request and returns the scripted answer, or throws it. */
function fakeEscalate(answer: FixOutput | Error) {
  const calls: EscalateOptions<FixOutput>[] = [];
  const escalate = async (
    options: EscalateOptions<FixOutput>,
  ): Promise<EscalationResult<FixOutput>> => {
    calls.push(options);
    if (answer instanceof Error) throw answer;
    return { value: answer, provider: "frontal", model: MODEL };
  };
  return { escalate, calls };
}

/** Records each offer and answers it with the given decision. */
function offerOf(answer: boolean) {
  const summaries: EscalationSummary[] = [];
  const offer = async (summary: EscalationSummary) => {
    summaries.push(summary);
    return answer;
  };
  return { offer, summaries };
}

describe("hosted escalation after an abstained fix", () => {
  let sb: Sandbox;
  let file: string;
  const original = () => readFileSync(file, "utf-8");

  beforeEach(() => {
    sb = makeSandbox("fcx-escalate-");
    file = join(sb.workspace, "src", "a.ts");
  });

  afterEach(() => {
    sb.cleanup();
  });

  function options(overrides: Partial<FixCommandOptions>): FixCommandOptions {
    return {
      workspace: sb.workspace,
      target: "src/a.ts:5",
      permissionMode: "workspace-write",
      dryRun: false,
      maxCandidates: 2,
      // Two candidates that both fail verification, so the local recipe abstains.
      model: scriptedModel([BREAKING_EDIT, BREAKING_EDIT]),
      approve: async () => false,
      undoRoot: undoRootFor(sb.cache, sb.workspace),
      logsDir: join(sb.cache, "logs"),
      ...overrides,
    };
  }

  function setup(
    escalate: EscalationSetup["escalate"],
    offer: EscalationSetup["offer"],
    policy = POLICY,
  ): EscalationSetup {
    return { provider: PROVIDER, model: MODEL, policy, offer, escalate };
  }

  it("verifies a hosted answer, proposes it in read-only mode and writes nothing", async () => {
    const hosted = fakeEscalate({ edits: GOOD_EDIT.edits });
    const asked = offerOf(true);
    const report = await runFixCommand(
      options({
        permissionMode: "read-only",
        escalation: setup(hosted.escalate, asked.offer),
      }),
    );

    expect(report.status).toBe("verified-escalated");
    expect(report.applied).toBe(false);
    expect(report.escalationOffered).toBe(true);
    expect(report.escalation).toMatchObject({
      status: "verified",
      provider: "frontal",
      model: MODEL,
    });
    expect(exitCodeFor(report.status)).toBe(0);
    expect(original()).toContain("export const label: string = total([1, 2]);");
    expect(hosted.calls).toHaveLength(1);
    expect(hosted.calls[0]?.request.files).toEqual(["src/a.ts"]);
    expect(asked.summaries[0]?.files).toEqual(["src/a.ts"]);
  });

  it("never puts the api key in the report, the offer or the output", async () => {
    const hosted = fakeEscalate(new Error(`upstream rejected ${API_KEY}`));
    const asked = offerOf(true);
    const report = await runFixCommand(
      options({ permissionMode: "read-only", escalation: setup(hosted.escalate, asked.offer) }),
    );
    expect(JSON.stringify(report)).not.toContain(API_KEY);
    expect(JSON.stringify(asked.summaries)).not.toContain(API_KEY);
  });

  it("applies a verified hosted answer in workspace-write mode and records it in memory", async () => {
    const memoryPath = memoryPathFor(sb.cache, sb.workspace);
    const hosted = fakeEscalate({ edits: GOOD_EDIT.edits });
    const report = await runFixCommand(
      options({
        memoryPath,
        escalation: setup(hosted.escalate, offerOf(true).offer),
      }),
    );

    expect(report.status).toBe("verified-escalated");
    expect(report.applied).toBe(true);
    expect(report.undoId).toBeTruthy();
    expect(original()).toContain("String(total([1, 2]))");

    const store = openMemory(memoryPath);
    const records = store.list({ kind: "accepted_fix" });
    store.close();
    expect(records[0]?.text).toContain("via hosted escalation");
  });

  it("reports escalation-declined with exit 4 when the user says no, and sends nothing", async () => {
    const hosted = fakeEscalate({ edits: GOOD_EDIT.edits });
    const report = await runFixCommand(
      options({ escalation: setup(hosted.escalate, offerOf(false).offer) }),
    );

    expect(report.status).toBe("escalation-declined");
    expect(report.escalationOffered).toBe(true);
    expect(exitCodeFor(report.status)).toBe(4);
    expect(hosted.calls).toHaveLength(0);
    expect(original()).toBe(SOURCE);
  });

  it("rejects a hosted answer that fails the defense layers, and does not apply it", async () => {
    const hosted = fakeEscalate({
      edits: [{ file: "src/a.ts", search: "no such text in the file", replace: "x" }],
    });
    const report = await runFixCommand(
      options({ escalation: setup(hosted.escalate, offerOf(true).offer) }),
    );

    expect(report.status).toBe("abstained");
    expect(report.escalation?.status).toBe("rejected");
    expect(report.escalation?.layers?.at(-1)).toMatchObject({ layer: "anchor", pass: false });
    expect(exitCodeFor(report.status)).toBe(2);
    expect(original()).toContain("export const label: string = total([1, 2]);");
  });

  it("reports a failed hosted call as abstained, with the api key redacted", async () => {
    const hosted = fakeEscalate(new Error(`auth failed for ${API_KEY}`));
    const report = await runFixCommand(
      options({ escalation: setup(hosted.escalate, offerOf(true).offer) }),
    );

    expect(report.status).toBe("abstained");
    expect(report.escalation).toMatchObject({ status: "failed" });
    expect(report.escalation?.message).toBe("auth failed for [redacted]");
    expect(JSON.stringify(report)).not.toContain(API_KEY);
    expect(exitCodeFor(report.status)).toBe(2);
  });

  it("denies escalation before any request when policy does not allow the provider", async () => {
    const hosted = fakeEscalate({ edits: GOOD_EDIT.edits });
    const report = await runFixCommand(
      options({
        escalation: setup(hosted.escalate, offerOf(true).offer, {
          ...POLICY,
          allowedProviders: [],
        }),
      }),
    );

    expect(report.status).toBe("abstained");
    expect(report.escalation?.status).toBe("policy-denied");
    expect(hosted.calls).toHaveLength(0);
  });

  it("offers nothing when no escalation setup is given", async () => {
    const asked = offerOf(true);
    const report = await runFixCommand(options({}));
    expect(report.status).toBe("abstained");
    expect(report.escalationOffered).toBe(false);
    expect(asked.summaries).toHaveLength(0);
    expect(exitCodeFor(report.status)).toBe(2);
  });

  it("asks again in prompt mode before applying a verified hosted answer", async () => {
    const hosted = fakeEscalate({ edits: GOOD_EDIT.edits });
    const report = await runFixCommand(
      options({
        permissionMode: "prompt",
        approve: async () => false,
        escalation: setup(hosted.escalate, offerOf(true).offer),
      }),
    );
    expect(report.status).toBe("declined");
    expect(exitCodeFor(report.status)).toBe(3);
    expect(hosted.calls).toHaveLength(1);
    expect(original()).toContain("export const label: string = total([1, 2]);");
  });
});

describe("escalation configuration", () => {
  const projectConfig = {
    runtime: {
      default_provider: "frontal",
      providers: { frontal: { enabled: true, default_model: MODEL } },
    },
  };
  const env = {
    HOME: "/",
    FRONTAL_API_KEY: API_KEY,
    FRONTAL_BASE_URL: "https://escalation.invalid/v1",
    FRONTAL_CODE_ENABLE_TELEMETRY: "inherit",
  } as const;
  const offer = async () => false;
  const policy = { ...POLICY, deny: [], permissionCeiling: null };

  it("builds a setup from the provider config and environment", () => {
    const built = escalationSetupFor({ projectConfig, policy, env }, offer);
    expect(built).toMatchObject({
      provider: { id: "frontal", baseUrl: env.FRONTAL_BASE_URL },
      model: MODEL,
    });
  });

  it("is unavailable without a default provider, a model, or credentials", () => {
    expect(escalationSetupFor({ projectConfig: {}, policy, env }, offer)).toBeUndefined();
    expect(
      escalationSetupFor(
        { projectConfig: { runtime: { default_provider: "frontal", providers: {} } }, policy, env },
        offer,
      ),
    ).toBeUndefined();
    expect(
      escalationSetupFor(
        { projectConfig, policy, env: { ...env, FRONTAL_API_KEY: undefined } },
        offer,
      ),
    ).toBeUndefined();
  });

  it("is off with --no-escalate, when disabled in config, or without a terminal", () => {
    const base = {
      enabled: true,
      isTTY: true,
      projectConfig,
      policy,
      env,
      offer,
      noEscalate: false,
    };
    expect(escalationOptionFor(base)).toBeDefined();
    expect(escalationOptionFor({ ...base, noEscalate: true })).toBeUndefined();
    expect(escalationOptionFor({ ...base, enabled: false })).toBeUndefined();
    expect(escalationOptionFor({ ...base, isTTY: false })).toBeUndefined();
  });

  it("parses --no-escalate as a global flag", () => {
    expect(parseGlobalArgs(["--no-escalate", "fix", "src/a.ts"]).noEscalate).toBe(true);
    expect(parseGlobalArgs(["fix", "src/a.ts"]).noEscalate).toBe(false);
  });
});

describe("exit codes", () => {
  it("maps every fix status to its documented exit code", () => {
    const expected: Array<[Parameters<typeof exitCodeFor>[0], number]> = [
      ["applied", 0],
      ["proposed", 0],
      ["verified-escalated", 0],
      ["no-diagnostics", 0],
      ["abstained", 2],
      ["declined", 3],
      ["escalation-declined", 4],
      ["error", 1],
    ];
    for (const [status, code] of expected) {
      expect(exitCodeFor(status)).toBe(code);
    }
  });
});

describe("exit code from the CLI", () => {
  it("exits 1 with a JSON error for a file that does not exist", async () => {
    const sb = makeSandbox("fcx-exit-");
    try {
      const { code, lines } = await captureLog(() =>
        run(
          parseGlobalArgs([
            "-C",
            sb.workspace,
            "--output-format",
            "json",
            "--no-escalate",
            "fix",
            "src/missing.ts",
          ]),
        ),
      );
      expect(code).toBe(1);
      expect(JSON.parse(lines.join("\n"))).toMatchObject({
        status: "error",
        error: { code: "FILE_NOT_FOUND" },
      });
    } finally {
      sb.cleanup();
    }
  });
});
