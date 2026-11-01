// promptVersion: 1
// User instruction block injected into every recipe's user prompt.
// Reads AGENTS.md from repo root plus nested AGENTS.md files on the path to the target file,
// plus skills from .frontal-code/skills (v1: conventions text only).
// Trimmed deterministically by heading priority, ≤ 300 tokens.

## Project Instructions (AGENTS.md)

The following instructions come from AGENTS.md files in the repository.
They apply to this task and must be followed:

{{AGENTS_MD_BLOCK}}

## Skills (.frontal-code/skills)

The following skills are available as conventions (v1: text only, no execution):

{{SKILLS_BLOCK}}
