import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GlobalArgs } from "../args.js";
import { emit } from "../output.js";

export interface InitReport {
  status: "ok" | "error";
  action: "init";
  root: string;
  created: string[];
  existing: string[];
  message?: string;
}

/** The settings written by `fcx init`. It only names fcx's own keys, and it is left for the user to edit. */
export const INIT_SETTINGS = {
  model: "ggml/auto",
  permissions: { defaultMode: "prompt" },
};

const README = `# .frontal-code

Project settings for fcx. \`settings.json\` is shared with the team and is read only in a trusted workspace.
Put machine-specific overrides in \`settings.local.json\`, which is for you alone and should not be committed.

Run \`fcx trust\` once in this repository to let these settings apply. \`fcx status\` shows what is in effect.
`;

const LOCAL_IGNORE = ".frontal-code/settings.local.json";

/**
 * `fcx init [path]`: creates \`.frontal-code/\` in the project with a README and a settings file. Files that already
 * exist are never changed. If the project has a \`.gitignore\`, the local settings file is added to it when missing.
 */
export function runInitCommand(args: GlobalArgs, cwd: string): number {
  const root = resolve(cwd, args.rest[0] ?? ".");
  const folder = join(root, ".frontal-code");
  const created: string[] = [];
  const existing: string[] = [];
  const fail = (message: string): number => {
    emit(
      args.outputFormat,
      { status: "error", action: "init", root, created, existing, message } satisfies InitReport,
      () => `fcx init: ${message}`,
    );
    return 1;
  };

  if (!existsSync(root)) return fail(`not a directory: ${root}`);
  mkdirSync(folder, { recursive: true });

  const files: [string, string][] = [
    ["README.md", README],
    ["settings.json", `${JSON.stringify(INIT_SETTINGS, null, 2)}\n`],
  ];
  for (const [name, content] of files) {
    const path = join(folder, name);
    if (existsSync(path)) {
      existing.push(`.frontal-code/${name}`);
    } else {
      writeFileSync(path, content);
      created.push(`.frontal-code/${name}`);
    }
  }

  const ignore = join(root, ".gitignore");
  if (existsSync(ignore)) {
    const current = readFileSync(ignore, "utf8");
    if (!current.split("\n").some((line) => line.trim() === LOCAL_IGNORE)) {
      writeFileSync(
        ignore,
        `${current.endsWith("\n") || current === "" ? current : `${current}\n`}${LOCAL_IGNORE}\n`,
      );
      created.push(".gitignore (added .frontal-code/settings.local.json)");
    }
  }

  const report: InitReport = { status: "ok", action: "init", root, created, existing };
  emit(args.outputFormat, report, () =>
    [
      `fcx init in ${root}`,
      ...created.map((f) => `  created ${f}`),
      ...existing.map((f) => `  kept existing ${f}`),
      created.length === 0 ? "  nothing to change" : "",
      "Next: fcx trust  (to let the project settings apply)",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );
  return 0;
}
