import { createInterface } from "node:readline/promises";
import type { Edit } from "@fcx/apply";
import { isWarmServerRequest } from "./client.js";

let protocolMode = false;
let activeTurn: AbortSignal | undefined;

/**
 * Marks this process as an ACP server (`fcx acp`). Its stdin is the protocol stream, so no prompt may read
 * from it. Set once, before the server starts.
 */
export function setProtocolMode(on: boolean): void {
  protocolMode = on;
}

/**
 * Sets the signal of the ACP prompt that is running, or clears it. While a signal is set and aborted, no write
 * is permitted (see `writesPermitted`).
 */
export function setActiveTurn(signal: AbortSignal | undefined): void {
  activeTurn = signal;
}

/**
 * True when prompts must decline: inside a warm-server request, or in ACP protocol mode. Declining is the only
 * answer there, so nothing can be approved, escalated or committed without a person.
 */
export function isNonInteractive(): boolean {
  return protocolMode || isWarmServerRequest();
}

/**
 * False once the active ACP prompt has been cancelled. Every write path checks this right before it writes, so
 * an edit that finishes generating after cancellation is never applied. True when no ACP prompt is active.
 */
export function writesPermitted(): boolean {
  return activeTurn === undefined || !activeTurn.aborted;
}

/**
 * Asks the user before writing. Declines when there is no terminal, so a script
 * or CI job can never approve a change by accident.
 */
export async function askToApply(summary: { file: string; edits: Edit[] }): Promise<boolean> {
  if (!process.stdin.isTTY || isNonInteractive()) return false;
  process.stdout.write(`\nProposed ${summary.edits.length} edit(s) to ${summary.file}:\n`);
  for (const edit of summary.edits) {
    process.stdout.write(`--- search\n${edit.search}\n+++ replace\n${edit.replace}\n`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Apply these edits? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * Asks whether to send the target file and diagnostic to the configured hosted model. Declines when there
 * is no terminal, so escalation never happens unattended.
 */
export async function askToEscalate(summary: {
  description: string;
  provider: string;
  model: string;
  files: readonly string[];
  approxTokens: number;
}): Promise<boolean> {
  if (!process.stdin.isTTY || isNonInteractive()) return false;
  process.stdout.write(
    `\nLocal fix abstained. Escalate to hosted model ${summary.provider}/${summary.model}?\n` +
      `  purpose: ${summary.description}\n` +
      `  will send: ${summary.files.join(", ")} (about ${summary.approxTokens} tokens)\n`,
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Send? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * Asks whether to run `git commit` with a generated message. Declines when there is no terminal, and inside the
 * warm server, so `commit --apply` never commits unattended.
 */
export async function askToCommit(message: string): Promise<boolean> {
  if (!process.stdin.isTTY || isNonInteractive()) return false;
  process.stdout.write(`\nCommit message:\n${message}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Run git commit with this message? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
