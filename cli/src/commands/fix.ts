import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type Edit, StaleFileError, applyPlan, planEdits, resolveInWorkspace } from "@fcx/apply";
import type { PermissionMode } from "@fcx/config";
import type { LayerOutcome } from "@fcx/defense";
import type { ModelHost } from "@fcx/model";
import { type CandidateReport, type LayerEvent, runFixDiagnostic } from "@fcx/recipes";
import { type Diagnostic, createTsChecker } from "@fcx/verify";
import { writesPermitted } from "../lib/approval.js";
import { type EscalationSetup, escalateAbstained } from "../lib/escalation.js";
import { instructionsFor } from "../lib/instructions.js";
import {
  type DefinitionsAt,
  type LanguageServerSession,
  openLanguageServer,
} from "../lib/language-server.js";
import { rememberSafely } from "../lib/memory.js";
import { publishLayerEvent } from "../lib/recipe-runtime.js";

export type FixStatus =
  | "applied"
  | "proposed"
  | "verified-escalated"
  | "abstained"
  | "escalation-declined"
  | "declined"
  | "no-diagnostics"
  | "error";

export type EscalationStatus = "declined" | "policy-denied" | "failed" | "rejected" | "verified";

export interface EscalationDetail {
  status: EscalationStatus;
  provider?: string;
  model?: string;
  message?: string;
  layers?: LayerOutcome[];
}

/** Instructions for one file, passed to approval. */
export interface Proposal {
  file: string;
  edits: Edit[];
}

export interface FixReport {
  status: FixStatus;
  recipe: "fix-diagnostic";
  file?: string;
  diagnostic?: Diagnostic;
  /** Edits that were applied, or proposed, or the unverified best candidate. */
  edits?: Edit[];
  undoId?: string;
  /** Set on verified-escalated: true when the edits were written. */
  applied?: boolean;
  candidates: Array<
    Pick<CandidateReport, "source" | "temperature" | "ms" | "pass" | "error"> & {
      layers: LayerOutcome[];
    }
  >;
  lastError?: string;
  error?: { code: string; message: string; hint?: string };
  /** True when the user was asked about a hosted escalation. */
  escalationOffered: boolean;
  escalation?: EscalationDetail;
  /** Project instructions (AGENTS.md, at most 300 tokens), sent with every candidate prompt. */
  instructions: string;
  /** Where the definition context came from. `lsp` only when a trusted language server answered a query. */
  context: { source: "lsp" | "checker"; notes: string[] };
  /** Non-fatal problems, for example a memory write that failed. */
  warnings: string[];
  timings: { totalMs: number };
}

export interface FixCommandOptions {
  workspace: string;
  /** `file` or `file:line`, relative to the workspace or absolute. */
  target: string;
  permissionMode: PermissionMode;
  dryRun: boolean;
  maxCandidates: number;
  model: Pick<ModelHost, "generateObject">;
  /** Called only in `prompt` mode. Returns true to apply. */
  approve: (proposal: Proposal) => Promise<boolean>;
  undoRoot: string;
  logsDir: string;
  /** Local memory database. When omitted, nothing is remembered. */
  memoryPath?: string;
  /** When set, an abstained fix is offered a hosted escalation. */
  escalation?: EscalationSetup;
  /** The workspace trust from resolveConfig. Only a trusted workspace may use a language server. Default false. */
  trusted?: boolean;
  /**
   * Replaces the language server for this run (tests use it to inject failures). Trust still gates it: an
   * untrusted workspace never uses a definition source.
   */
  definitionsAt?: DefinitionsAt;
}

export interface ParsedTarget {
  file: string;
  line?: number;
}

export function parseTarget(target: string): ParsedTarget {
  const match = /^(.*?)(?::(\d+))?$/.exec(target);
  const file = match?.[1] ?? target;
  if (!file) throw new Error("expected a file, for example: fcx fix src/app.ts:12");
  const line = match?.[2] ? Number.parseInt(match[2], 10) : undefined;
  if (line !== undefined && line < 1) throw new Error("line numbers start at 1");
  return { file, line };
}

/** Per-run values that are filled in during the run and attached to whatever report it returns. */
interface RunContext {
  instructions: string;
  warnings: string[];
  context: FixReport["context"];
}

type Timings = () => { totalMs: number };
type FixBody = Omit<FixReport, "instructions" | "warnings" | "context">;

/**
 * Runs fix-diagnostic and applies the result according to the permission mode. The language server (if any) is
 * opened for this run only and shut down in the finally, whatever the outcome.
 */
export async function runFixCommand(options: FixCommandOptions): Promise<FixReport> {
  const trusted = options.trusted === true;
  const session: LanguageServerSession =
    trusted && options.definitionsAt !== undefined
      ? { notes: [], close: async () => {}, definitionsAt: options.definitionsAt }
      : await openLanguageServer(options.workspace, trusted);
  try {
    const ctx: RunContext = {
      instructions: "",
      warnings: [],
      context: { source: "checker", notes: [...session.notes] },
    };
    const report = await runFixInner({ ...options, definitionsAt: session.definitionsAt }, ctx);
    return {
      ...report,
      instructions: ctx.instructions,
      warnings: ctx.warnings,
      context: ctx.context,
    };
  } finally {
    await session.close();
  }
}

async function runFixInner(options: FixCommandOptions, ctx: RunContext): Promise<FixBody> {
  const t0 = performance.now();
  const timings: Timings = () => ({ totalMs: Math.round(performance.now() - t0) });
  let parsed: ParsedTarget;
  try {
    parsed = parseTarget(options.target);
  } catch (error) {
    return failure("INVALID_TARGET", error, timings);
  }

  let file: string;
  try {
    file = resolveInWorkspace(options.workspace, parsed.file);
  } catch (error) {
    return failure("PATH_OUTSIDE_WORKSPACE", error, timings);
  }
  if (!existsSync(file)) {
    return failure("FILE_NOT_FOUND", new Error(`no such file: ${parsed.file}`), timings);
  }
  ctx.instructions = instructionsFor(options.workspace, file, ctx.warnings);

  // Plan §5.5: our logs live under logs/fc/.
  const logDir = join(options.logsDir, "fc");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, "defense.jsonl");
  const checker = createTsChecker(options.workspace, file);
  try {
    const result = await runFixDiagnostic({
      model: options.model,
      checker,
      workspace: options.workspace,
      file,
      line: parsed.line,
      maxCandidates: options.maxCandidates,
      instructions: ctx.instructions,
      definitionsAt: options.definitionsAt,
      onLayer: (event: LayerEvent) => {
        appendFileSync(
          logPath,
          `${JSON.stringify({ task: "fix", recipe: "fix-diagnostic", ...event })}\n`,
        );
        publishLayerEvent(event);
      },
    });

    if (result.status === "no-diagnostics") {
      return {
        status: "no-diagnostics",
        recipe: "fix-diagnostic",
        file,
        candidates: [],
        escalationOffered: false,
        timings: timings(),
      };
    }

    ctx.context = {
      source: result.context.source,
      notes: [...ctx.context.notes, ...result.context.notes],
    };

    const candidates = result.candidates.map(summarize);
    if (result.status === "abstained") {
      const abstained: FixBody = {
        status: "abstained",
        recipe: "fix-diagnostic",
        file,
        diagnostic: result.diagnostic,
        edits: result.bestCandidate,
        candidates,
        lastError: result.lastError,
        escalationOffered: false,
        timings: timings(),
      };
      if (!options.escalation) return abstained;

      const setup = options.escalation;
      const outcome = await escalateAbstained({
        setup,
        checker,
        workspace: options.workspace,
        file,
        target: result.diagnostic,
      });
      const provider = setup.provider.id;
      const model = setup.model;
      switch (outcome.status) {
        case "declined":
          return {
            ...abstained,
            status: "escalation-declined",
            escalationOffered: true,
            escalation: { status: "declined", provider, model },
            timings: timings(),
          };
        case "policy-denied":
        case "failed":
          return {
            ...abstained,
            escalationOffered: true,
            escalation: { status: outcome.status, provider, model, message: outcome.message },
            timings: timings(),
          };
        case "rejected":
          return {
            ...abstained,
            escalationOffered: true,
            escalation: {
              status: "rejected",
              provider,
              model,
              message: outcome.feedback,
              layers: outcome.layers,
            },
            timings: timings(),
          };
        case "verified":
          return finishFix({
            options,
            ctx,
            file,
            diagnostic: result.diagnostic,
            edits: outcome.edits,
            baseText: outcome.baseText,
            candidates,
            escalated: true,
            escalation: {
              status: "verified",
              provider: outcome.provider,
              model: outcome.model,
              layers: outcome.layers,
            },
            timings,
          });
      }
    }

    return finishFix({
      options,
      ctx,
      file,
      diagnostic: result.diagnostic,
      edits: result.edits,
      baseText: result.baseText,
      candidates,
      escalated: false,
      timings,
    });
  } catch (error) {
    const hint = (error as { hint?: unknown }).hint;
    const report = failure("FIX_FAILED", error, timings);
    if (report.error && typeof hint === "string") report.error.hint = hint;
    return report;
  } finally {
    checker.dispose();
  }
}

interface FinishInput {
  options: FixCommandOptions;
  ctx: RunContext;
  file: string;
  diagnostic: Diagnostic;
  edits: Edit[];
  baseText: string;
  candidates: FixBody["candidates"];
  escalated: boolean;
  escalation?: EscalationDetail;
  timings: Timings;
}

/**
 * Applies a verified result according to the permission mode. An escalated result is a proposal too: it
 * is reported as verified-escalated and follows the same approval rules as a local fix.
 */
async function finishFix(input: FinishInput): Promise<FixBody> {
  const { options, ctx, file, diagnostic, edits, baseText, escalated, timings } = input;
  const escalationOffered = input.escalation !== undefined;
  const base = {
    recipe: "fix-diagnostic" as const,
    file,
    diagnostic,
    edits,
    candidates: input.candidates,
    escalationOffered,
    escalation: input.escalation,
  };

  if (options.dryRun || options.permissionMode === "read-only") {
    return escalated
      ? { ...base, status: "verified-escalated", applied: false, timings: timings() }
      : { ...base, status: "proposed", timings: timings() };
  }

  if (options.permissionMode === "prompt") {
    const approved = await options.approve({ file, edits });
    if (!approved) return { ...base, status: "declined", timings: timings() };
  }

  // A cancelled ACP prompt may still be generating. It must never reach a write.
  if (!writesPermitted()) {
    return { ...base, status: "declined", timings: timings() };
  }

  try {
    // Plan from the text the edits were verified against, so a change made during generation is never overwritten.
    const plan = planEdits(options.workspace, edits, new Map([[file, baseText]]));
    const applied = applyPlan(plan, options.undoRoot);
    if (options.memoryPath !== undefined) {
      const text = `fixed TS${diagnostic.code} "${diagnostic.message}" at line ${diagnostic.line} with ${edits.length} edit(s)${escalated ? " via hosted escalation" : ""}`;
      const filePath = relative(options.workspace, file).split("\\").join("/");
      const warning = await rememberSafely(options.memoryPath, (store) =>
        store.recordAcceptedFix({ text, filePath }),
      );
      if (warning) ctx.warnings.push(warning);
    }
    return escalated
      ? {
          ...base,
          status: "verified-escalated",
          applied: true,
          undoId: applied.undoId,
          timings: timings(),
        }
      : { ...base, status: "applied", undoId: applied.undoId, timings: timings() };
  } catch (error) {
    if (error instanceof StaleFileError) {
      return {
        ...base,
        status: "error",
        error: { code: "STALE_FILE", message: error.message },
        timings: timings(),
      };
    }
    throw error;
  }
}

export function exitCodeFor(status: FixStatus): number {
  switch (status) {
    case "applied":
    case "proposed":
    case "verified-escalated":
    case "no-diagnostics":
      return 0;
    case "abstained":
      return 2;
    case "declined":
      return 3;
    case "escalation-declined":
      return 4;
    case "error":
      return 1;
  }
}

function summarize(c: CandidateReport): FixReport["candidates"][number] {
  return {
    source: c.source,
    temperature: c.temperature,
    ms: c.ms,
    pass: c.pass,
    error: c.error,
    layers: c.layers,
  };
}

function failure(code: string, error: unknown, timings: Timings): FixBody {
  return {
    status: "error",
    recipe: "fix-diagnostic",
    candidates: [],
    error: { code, message: error instanceof Error ? error.message : String(error) },
    escalationOffered: false,
    timings: timings(),
  };
}
