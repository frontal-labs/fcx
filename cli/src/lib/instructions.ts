import { projectInstructions } from "@fcx/memory";

/** Token budget for project instructions (plan section 12.2). */
export const INSTRUCTION_BUDGET_TOKENS = 300;

/**
 * Project instructions for an absolute target path (a file, or `<workspace>/AGENTS.md` for the root). A failure
 * to read them is a warning, never a failed run.
 */
export function instructionsFor(workspace: string, target: string, warnings: string[]): string {
  try {
    return projectInstructions(workspace, target, INSTRUCTION_BUDGET_TOKENS).text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`project instructions not loaded: ${message}`);
    return "";
  }
}
