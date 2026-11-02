/**
 * commit-message: writes a conventional commit message for the changes staged in a git repository.
 *
 * Input: a repository directory. Context: `git diff --staged` (argv array, no shell, read up to 64 KiB) and the last
 * 20 commit subjects for style. If nothing is staged, the result is "no-changes" and the model is not called.
 * Output: { type, scope?, subject, body? }. type is one of the eleven conventional types. The message is never
 * committed; the caller decides what to do with it.
 * Layers: constrain (subject is at most 72 characters, has no line break, no surrounding whitespace, and no trailing
 * period), verify (the header formats and parses back to the same type, scope and subject).
 *
 * Verifies: the output matches the schema; the subject is at most 72 characters with no trailing period; the header
 * `type(scope): subject` parses as a conventional commit header and round-trips to the same fields.
 * Does NOT verify: that the message describes the diff accurately or completely (there is no model-free check for
 * that); that the body is wrapped; that the repository's commitlint rules, if any, pass (not configured here); or
 * that the diff was not truncated. A truncated diff is reported with `diffTruncated`, and the prompt says so.
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { LayerOutcome } from "@fcx/defense";
import type { ModelHost } from "@fcx/model";
import * as z from "zod";
import { RecipeInputError } from "../context.js";
import {
  CANDIDATE_TEMPERATURES,
  type CandidateReport,
  type LayerEvent,
  type RecipeDefinition,
  type VerificationScope,
  elapsed,
  requireWork,
  runRecipeEngine,
} from "../engine.js";

/** Versioned in prompts/commit-message.md (promptVersion 1). A test keeps this constant identical to that file. */
export const COMMIT_MESSAGE_SYSTEM = `You are a coding agent writing a conventional commit message for a staged change. Given the staged diff and the recent commit subjects of this repository, write the commit message.

Constraints:
- type must be one of: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.
- scope is optional: one short lowercase word for the area changed, such as a package or module name. Omit it when the change spans many areas.
- subject: imperative mood ("add", "fix", not "added" or "fixes"), at most 72 characters, no trailing period, no line breaks.
- body is optional. Use it only for the reason behind the change or a notable consequence.
- Match the style of the recent subjects when it is clear.
- Describe only what the diff shows. The diff may be truncated; if it is, describe only the part shown. Do not invent issue numbers, ticket names, or authors.
- Output must be valid JSON matching the schema: { "type": "...", "scope": "...", "subject": "...", "body": "..." }. scope and body are optional.`;

export const COMMIT_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
] as const;

export const CommitMessageSchema = z.object({
  type: z.enum(COMMIT_TYPES),
  // No regex here: the grammar builder that constrains decoding rejects the `pattern` keyword.
  // The scope format is checked in conventionalLayer instead, with feedback the model can act on.
  scope: z.string().min(1).max(32).optional(),
  subject: z.string().min(1),
  body: z.string().optional(),
});
export type CommitMessage = z.infer<typeof CommitMessageSchema>;

export const COMMIT_MESSAGE_SCOPE: VerificationScope = {
  ran: [
    "git diff --staged (read)",
    "subject length and punctuation",
    "conventional-commit round trip",
  ],
  notRun: [
    "accuracy of the message to the diff",
    "body wrapping",
    "commitlint rules (not configured)",
  ],
};

/** Largest staged diff sent to the model, in bytes. */
export const DIFF_LIMIT_BYTES = 64 * 1024;
/** Number of recent commit subjects sent for style. */
export const RECENT_SUBJECTS = 20;
const SUBJECT_MAX = 72;
const HEADER = new RegExp(`^(${COMMIT_TYPES.join("|")})(?:\\(([^()\\r\\n]+)\\))?!?: (.+)$`);

export interface CommitMessageOptions {
  model: Pick<ModelHost, "generateObject">;
  /** The repository directory. */
  repo: string;
  /** Number of model candidates to try (plan §10: 4 on tier S, 6 on tier M). */
  maxCandidates: number;
  onLayer?: (event: LayerEvent) => void;
  /** The project instruction block (plan §12.2). Added to the user part of every candidate prompt. See src/instructions.ts. */
  instructions?: string;
}

export type CommitMessageResult =
  | { status: "no-changes"; ms: number }
  | {
      status: "verified";
      message: CommitMessage;
      /** The message as git would store it: header, blank line, body. */
      text: string;
      diffTruncated: boolean;
      candidates: CandidateReport[];
      ms: number;
      instructionsTruncated: boolean;
      verification: VerificationScope;
    }
  | {
      status: "abstained";
      lastError: string;
      diffTruncated: boolean;
      candidates: CandidateReport[];
      ms: number;
      instructionsTruncated: boolean;
      verification: VerificationScope;
    };

/** Runs the commit-message recipe. Throws RecipeInputError when the path is not a directory or git fails on it. */
export async function runCommitMessage(
  options: CommitMessageOptions,
): Promise<CommitMessageResult> {
  const t0 = performance.now();
  const repo = resolve(options.repo);
  if (!isDirectory(repo)) {
    throw new RecipeInputError(`not a directory: ${options.repo}`);
  }

  const diff = await git(
    repo,
    ["diff", "--staged", "--no-color", "--no-ext-diff", "--no-textconv"],
    DIFF_LIMIT_BYTES,
  );
  if (diff.code !== 0 && !diff.truncated) {
    throw new RecipeInputError(
      `${repo} is not a git repository, or git failed: ${diff.stderr.trim()}`,
    );
  }
  if (diff.stdout.trim() === "" && !diff.truncated) {
    return { status: "no-changes", ms: elapsed(t0) };
  }

  // A repository with no commits has no log. That is not an error: the message just has no style examples.
  const log = await git(
    repo,
    ["--no-pager", "log", `--max-count=${RECENT_SUBJECTS}`, "--format=%s"],
    DIFF_LIMIT_BYTES,
  );
  const subjects =
    log.code === 0
      ? log.stdout
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s !== "")
      : [];

  const recipe: RecipeDefinition<CommitMessage> = {
    schema: CommitMessageSchema,
    temperatures: CANDIDATE_TEMPERATURES,
    prompt: (feedback) => ({
      system: COMMIT_MESSAGE_SYSTEM,
      user: [
        diff.truncated
          ? `Staged diff (truncated at ${DIFF_LIMIT_BYTES} bytes; describe only the part shown):`
          : "Staged diff:",
        diff.stdout,
        "",
        "Recent commit subjects, newest first:",
        subjects.length > 0 ? subjects.map((s) => `- ${s}`).join("\n") : "(none)",
        ...(feedback ? ["", `Your previous attempt was rejected: ${feedback}`] : []),
      ].join("\n"),
    }),
    toEdits: () => [],
    layers: [
      {
        name: "constrain",
        check: ({ output }) => (output ? subjectLayer(output) : missingOutput("constrain")),
      },
      {
        name: "verify",
        check: ({ output }) => (output ? conventionalLayer(output) : missingOutput("verify")),
      },
    ],
  };

  const result = requireWork(
    await runRecipeEngine({
      recipe,
      model: options.model,
      workspace: repo,
      allowedFiles: [],
      primaryFile: repo,
      maxCandidates: options.maxCandidates,
      onLayer: options.onLayer,
      instructions: options.instructions,
    }),
  );
  const ms = elapsed(t0);
  if (result.status === "verified" && result.output) {
    return {
      status: "verified",
      message: result.output,
      text: formatMessage(result.output),
      diffTruncated: diff.truncated,
      candidates: result.candidates,
      ms,
      instructionsTruncated: result.instructionsTruncated,
      verification: COMMIT_MESSAGE_SCOPE,
    };
  }
  return {
    status: "abstained",
    lastError: result.status === "abstained" ? result.lastError : "no candidate passed every check",
    diffTruncated: diff.truncated,
    candidates: result.candidates,
    ms,
    instructionsTruncated: result.instructionsTruncated,
    verification: COMMIT_MESSAGE_SCOPE,
  };
}

/** The header line, `type(scope): subject`. */
export function formatHeader(message: CommitMessage): string {
  return `${message.type}${message.scope ? `(${message.scope})` : ""}: ${message.subject}`;
}

/** The whole message: header, then the body after a blank line when there is one. */
export function formatMessage(message: CommitMessage): string {
  const header = formatHeader(message);
  const body = message.body?.trim();
  return body ? `${header}\n\n${body}` : header;
}

/** Constrain: the subject is one line of at most 72 characters, with no surrounding whitespace and no trailing period. */
function subjectLayer(message: CommitMessage): LayerOutcome {
  const subject = message.subject;
  if (subject.trim() !== subject) {
    return failure(
      "constrain",
      "SUBJECT_WHITESPACE",
      "The subject starts or ends with whitespace. Trim it.",
    );
  }
  if (/[\r\n]/.test(subject)) {
    return failure(
      "constrain",
      "SUBJECT_MULTILINE",
      "The subject spans more than one line. Put the rest in the body.",
    );
  }
  if (subject.length > SUBJECT_MAX) {
    return failure(
      "constrain",
      "SUBJECT_TOO_LONG",
      `The subject is ${subject.length} characters. Keep it to ${SUBJECT_MAX} or fewer.`,
    );
  }
  if (subject.endsWith(".")) {
    return failure(
      "constrain",
      "SUBJECT_TRAILING_PERIOD",
      "The subject ends with a period. Remove it.",
    );
  }
  return { layer: "constrain", pass: true, ms: 0 };
}

/** A scope is one lowercase word: letters, digits, and . _ / - only. */
const SCOPE_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/;

/** Verify: the header parses as a conventional commit and gives back the same type, scope and subject. */
function conventionalLayer(message: CommitMessage): LayerOutcome {
  if (message.scope !== undefined && !SCOPE_PATTERN.test(message.scope)) {
    return failure(
      "verify",
      "NOT_CONVENTIONAL",
      "The scope must be one lowercase word: letters, digits, and . _ / - only, starting with a letter or digit.",
    );
  }
  const parsed = HEADER.exec(formatHeader(message));
  if (
    !parsed ||
    parsed[1] !== message.type ||
    (parsed[2] ?? undefined) !== message.scope ||
    parsed[3] !== message.subject
  ) {
    return failure(
      "verify",
      "NOT_CONVENTIONAL",
      "The header does not parse as a conventional commit. Use type(scope): subject, with type from the allowed list.",
    );
  }
  return { layer: "verify", pass: true, ms: 0 };
}

function missingOutput(layer: "constrain" | "verify"): LayerOutcome {
  return failure(layer, "NO_OUTPUT", "The output was empty. Output the JSON object.");
}

function failure(
  layer: "constrain" | "verify",
  reasonCode: string,
  feedback: string,
): LayerOutcome {
  return { layer, pass: false, ms: 0, reasonCode, feedback };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

interface GitOutput {
  stdout: string;
  stderr: string;
  /** Exit code, or null when the output was cut off and git was stopped. */
  code: number | null;
  truncated: boolean;
}

/**
 * Runs git with an argv array, no shell. Reads at most `limit` bytes of stdout; past that the process is stopped
 * and `truncated` is set.
 */
function git(cwd: string, args: readonly string[], limit: number): Promise<GitOutput> {
  return new Promise((done, failed) => {
    const child = spawn("git", [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const room = limit - size;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        size = limit;
        truncated = true;
        child.kill();
      } else {
        chunks.push(chunk);
        size += chunk.length;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf-8");
    });
    child.on("error", failed);
    child.on("close", (code) => {
      done({ stdout: Buffer.concat(chunks).toString("utf-8"), stderr, code, truncated });
    });
  });
}
