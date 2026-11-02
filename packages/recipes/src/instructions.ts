/**
 * The project instruction block (plan §12.2). The coordinator extracts it from AGENTS.md and passes it as
 * `instructions` to every recipe. It goes into the USER part of each prompt, after the system text, under a fixed
 * heading. The system text is never changed, so the prompt-prefix cache still works.
 *
 * Budget: plan §12.2 caps the block at 300 tokens. The coordinator trims it by heading priority. This module is the
 * defensive second line. It cuts anything longer than INSTRUCTIONS_MAX_CHARS at a line boundary and reports it, so the
 * caller can say so. The 1200-character limit is 300 tokens at about 4 characters per token.
 */

/** Heading that introduces the instruction block in the user part of a prompt. */
export const INSTRUCTIONS_HEADING = "Project instructions:";

/** Longest instruction text sent to a model. Longer text is cut at a line boundary. */
export const INSTRUCTIONS_MAX_CHARS = 1200;

export interface PreparedInstructions {
  /** The text to send. Empty when nothing should be sent. */
  readonly text: string;
  /** True when the input was longer than INSTRUCTIONS_MAX_CHARS and was cut. */
  readonly truncated: boolean;
}

/**
 * Normalizes an instruction block. Whitespace-only input is treated as absent. Text longer than
 * INSTRUCTIONS_MAX_CHARS keeps whole lines, in order, while they fit. If the first line alone does not fit, the
 * result is empty and `truncated` is still true.
 */
export function prepareInstructions(instructions: string | undefined): PreparedInstructions {
  const text = (instructions ?? "").trimEnd();
  if (text.trim() === "") return { text: "", truncated: false };
  if (text.length <= INSTRUCTIONS_MAX_CHARS) return { text, truncated: false };
  const kept: string[] = [];
  let length = 0;
  for (const line of text.split("\n")) {
    const next = length + (kept.length > 0 ? 1 : 0) + line.length;
    if (next > INSTRUCTIONS_MAX_CHARS) break;
    kept.push(line);
    length = next;
  }
  return { text: kept.join("\n").trimEnd(), truncated: true };
}

/**
 * Puts the instruction block at the start of a user prompt, before the task-specific text. With no instruction text,
 * the user prompt is returned unchanged, byte for byte.
 */
export function withInstructions(user: string, instructionText: string): string {
  if (instructionText === "") return user;
  return `${INSTRUCTIONS_HEADING}\n${instructionText}\n\n${user}`;
}
