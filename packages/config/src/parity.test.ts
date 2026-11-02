import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveConfig } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = resolvePath(__dirname, "../../../fixtures/config/cases");

function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = resolvePath(src, entry.name);
    const to = resolvePath(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else {
      copyFileSync(from, to);
    }
  }
}

function listCases(): string[] {
  return readdirSync(FIXTURES_ROOT)
    .filter((d) => /^\d{3}$/.test(d))
    .sort();
}

describe("config parity", () => {
  const origEnv = { ...process.env };
  const origCwd = process.cwd();

  afterAll(() => {
    process.chdir(origCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in origEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(origEnv)) {
      process.env[key] = value === undefined ? "" : value;
    }
  });

  for (const caseId of listCases()) {
    it(`case ${caseId}`, () => {
      const caseDir = resolvePath(FIXTURES_ROOT, caseId);
      const env = JSON.parse(readFileSync(resolvePath(caseDir, "env.json"), "utf-8"));
      const expected = JSON.parse(readFileSync(resolvePath(caseDir, "expected.json"), "utf-8"));

      const configHome = env.FRONTAL_CODE_CONFIG_HOME ?? expected.configHome;

      // Mirror the fixture into the resolved config home so the implementation
      // reads from the same locations the expected output was computed against.
      rmSync(configHome, { recursive: true, force: true });
      mkdirSync(configHome, { recursive: true });
      copyDir(resolvePath(caseDir, "home"), configHome);
      copyDir(resolvePath(caseDir, "repo"), resolvePath(configHome, "repo"));

      if (expected.trust?.trusted) {
        writeFileSync(
          resolvePath(configHome, "trusted-workspaces.json"),
          JSON.stringify({ trustedWorkspaces: [configHome] }),
        );
      }

      const cwd = resolvePath(configHome, "repo");

      const saved: Record<string, string | undefined> = {};
      const keys = new Set([
        ...Object.keys(env),
        "FRONTAL_CODE_CONFIG_HOME",
        "FRONTAL_CODE_HOME",
        "HOME",
      ]);
      for (const key of keys) {
        saved[key] = process.env[key];
      }

      process.env.HOME = configHome;
      // Apply every env var declared by the fixture (not just FRONTAL_CODE_*).
      for (const [key, value] of Object.entries(env)) {
        process.env[key] = String(value);
      }
      // Frontal Code resolves the config home from FRONTAL_CODE_CONFIG_HOME, then $HOME/.frontal-code.
      // Point the fixture home at the copied directory unless the case sets it itself.
      if (!("FRONTAL_CODE_CONFIG_HOME" in env)) {
        process.env.FRONTAL_CODE_CONFIG_HOME = configHome;
      }
      if (!("FRONTAL_CODE_HOME" in env)) {
        Reflect.deleteProperty(process.env, "FRONTAL_CODE_HOME");
      }

      let result: ReturnType<typeof resolveConfig>;
      try {
        process.chdir(cwd);
        result = resolveConfig(cwd);
      } finally {
        process.chdir(origCwd);
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }

      expect(result).toEqual(expected);
    });
  }
});
