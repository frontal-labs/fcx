import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryError, type MemoryStore, approximateTokens, openMemory } from "../src/index";
import { type TempDir, makeTempDir } from "./helpers";

const ERROR_CODE = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof MemoryError ? error.code : "other";
  }
  return undefined;
};

describe("MemoryStore", () => {
  let dir: TempDir;
  let store: MemoryStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    dir = makeTempDir();
    store = openMemory(join(dir.path, "memory", "memory.sqlite"));
  });

  afterEach(() => {
    store.close();
    dir.cleanup();
    vi.useRealTimers();
  });

  describe("remember and list", () => {
    it("stores a record with id, kind, text, file, symbol, source and createdAt", () => {
      const record = store.remember({
        kind: "accepted_fix",
        text: "  Use optional chaining  ",
        filePath: "src/a.ts",
        symbol: "load",
        source: "fcx",
      });
      expect(record).toEqual({
        id: 1,
        kind: "accepted_fix",
        text: "Use optional chaining",
        filePath: "src/a.ts",
        symbol: "load",
        source: "fcx",
        createdAt: Date.parse("2026-01-01T00:00:00Z"),
      });
    });

    it("stores null for an absent file and symbol", () => {
      const record = store.remember({ kind: "rejected", text: "Do not rename", source: "undo" });
      expect(record.filePath).toBeNull();
      expect(record.symbol).toBeNull();
    });

    it("rejects empty text, an empty source, unknown kinds and over-long text", () => {
      expect(ERROR_CODE(() => store.remember({ kind: "rejected", text: "   ", source: "x" }))).toBe(
        "invalid_record",
      );
      expect(ERROR_CODE(() => store.remember({ kind: "rejected", text: "ok", source: " " }))).toBe(
        "invalid_record",
      );
      expect(
        ERROR_CODE(() =>
          store.remember({ kind: "nope" as unknown as "rejected", text: "ok", source: "x" }),
        ),
      ).toBe("invalid_record");
      expect(
        ERROR_CODE(() => store.remember({ kind: "rejected", text: "a".repeat(1001), source: "x" })),
      ).toBe("invalid_record");
    });

    it("lists newest first and filters by kind, file and symbol", () => {
      store.remember({ kind: "convention", text: "one", filePath: "a.ts", source: "s" });
      vi.setSystemTime(new Date("2026-01-01T00:00:01Z"));
      store.remember({
        kind: "accepted_fix",
        text: "two",
        filePath: "a.ts",
        symbol: "f",
        source: "s",
      });
      vi.setSystemTime(new Date("2026-01-01T00:00:02Z"));
      store.remember({ kind: "rejected", text: "three", filePath: "b.ts", source: "s" });

      expect(store.list().map((r) => r.text)).toEqual(["three", "two", "one"]);
      expect(store.list({ kind: "accepted_fix" }).map((r) => r.text)).toEqual(["two"]);
      expect(store.list({ filePath: "a.ts" }).map((r) => r.text)).toEqual(["two", "one"]);
      expect(store.list({ symbol: "f" }).map((r) => r.text)).toEqual(["two"]);
      expect(store.list({ kind: "rejected", filePath: "a.ts" })).toEqual([]);
    });
  });

  describe("secret rejection", () => {
    const secrets: [string, string][] = [
      ["a private key header", "-----BEGIN RSA PRIVATE KEY-----"],
      ["a bearer token", "Authorization: Bearer abcdefghijklmnop1234567890"],
      ["an sk- key", "use sk-ant-abcdefghijklmnopqrstuv"],
      ["an AWS access key", "AKIAABCDEFGHIJKLMNOP"],
      ["a GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
      ["a Google API key", "AIzaSyA1234567890abcdefghijklmnopqrstuv"],
      ["a Slack token", "xoxb-1234567890-abcdefghij"],
      ["a credential assignment", 'password = "hunter2hunter2xyz"'],
    ];

    for (const [label, text] of secrets) {
      it(`refuses ${label} with a typed error and stores nothing`, () => {
        expect(ERROR_CODE(() => store.remember({ kind: "rejected", text, source: "x" }))).toBe(
          "secret_detected",
        );
        expect(store.list()).toEqual([]);
      });
    }

    it("refuses a secret in the symbol or file path too", () => {
      expect(
        ERROR_CODE(() =>
          store.remember({
            kind: "rejected",
            text: "ok",
            symbol: "sk-abcdefghijklmnopqrstu",
            source: "x",
          }),
        ),
      ).toBe("secret_detected");
    });

    it("does not reject ordinary text", () => {
      expect(
        ERROR_CODE(() =>
          store.remember({
            kind: "convention",
            text: "Token count is 300 and the key is typed",
            source: "x",
          }),
        ),
      ).toBeUndefined();
    });

    it("does not echo the secret in the error message", () => {
      try {
        store.remember({ kind: "rejected", text: "AKIAABCDEFGHIJKLMNOP", source: "x" });
        expect.unreachable();
      } catch (error) {
        expect(error instanceof Error && error.message).not.toContain("AKIA");
      }
    });
  });

  describe("forget and clear", () => {
    it("forgets one record by id and reports whether it existed", () => {
      const a = store.remember({ kind: "rejected", text: "a", source: "x" });
      expect(store.forget(a.id)).toBe(true);
      expect(store.forget(a.id)).toBe(false);
      expect(store.list()).toEqual([]);
    });

    it("clears records matching a filter and returns the count", () => {
      store.remember({ kind: "rejected", text: "a", filePath: "a.ts", source: "x" });
      store.remember({ kind: "rejected", text: "b", filePath: "b.ts", source: "x" });
      store.remember({ kind: "convention", text: "c", filePath: "a.ts", source: "x" });
      expect(store.clear({ kind: "rejected", filePath: "a.ts" })).toBe(1);
      expect(store.list().map((r) => r.text)).toEqual(["c", "b"]);
    });

    it("clears every record without a filter", () => {
      store.remember({ kind: "rejected", text: "a", source: "x" });
      store.remember({ kind: "convention", text: "b", source: "x" });
      expect(store.clear()).toBe(2);
      expect(store.list()).toEqual([]);
    });
  });

  describe("recording helpers", () => {
    it("recordAcceptedFix and recordRejected store the matching kind with a default source", () => {
      const fix = store.recordAcceptedFix({ text: "fixed null check", filePath: "a.ts" });
      const rejected = store.recordRejected({ text: "undone rename", symbol: "load" });
      expect(fix.kind).toBe("accepted_fix");
      expect(fix.source).toBe("auto");
      expect(rejected.kind).toBe("rejected");
      expect(rejected.symbol).toBe("load");
    });

    it("applies the same secret rejection to the helpers", () => {
      expect(ERROR_CODE(() => store.recordRejected({ text: "AKIAABCDEFGHIJKLMNOP" }))).toBe(
        "secret_detected",
      );
    });
  });

  describe("forNeighborhood", () => {
    it("returns records attached to the given files or symbols and no others", () => {
      store.remember({ kind: "accepted_fix", text: "by file", filePath: "a.ts", source: "x" });
      store.remember({ kind: "accepted_fix", text: "by symbol", symbol: "load", source: "x" });
      store.remember({ kind: "accepted_fix", text: "unrelated", filePath: "z.ts", source: "x" });
      const result = store.forNeighborhood(["a.ts"], ["load"], 300);
      expect(result.records.map((r) => r.text).sort()).toEqual(["by file", "by symbol"]);
    });

    it("orders by kind priority first, then newest first", () => {
      store.remember({ kind: "rejected", text: "rejected new", filePath: "a.ts", source: "x" });
      vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
      store.remember({ kind: "accepted_fix", text: "fix new", filePath: "a.ts", source: "x" });
      vi.setSystemTime(new Date("2026-01-03T00:00:00Z"));
      store.remember({ kind: "accepted_fix", text: "fix newest", filePath: "a.ts", source: "x" });
      store.remember({ kind: "convention", text: "convention", filePath: "", source: "x" });
      const result = store.forNeighborhood(["a.ts"], [], 300);
      expect(result.records.map((r) => r.text)).toEqual([
        "convention",
        "fix newest",
        "fix new",
        "rejected new",
      ]);
    });

    it("trims to the token budget and reports the tokens used", () => {
      for (let i = 0; i < 10; i++) {
        store.remember({
          kind: "accepted_fix",
          text: `fix number ${i} here`,
          filePath: "a.ts",
          source: "x",
        });
      }
      const result = store.forNeighborhood(["a.ts"], [], 40);
      expect(result.records.length).toBeGreaterThan(0);
      expect(result.records.length).toBeLessThan(10);
      expect(result.tokens).toBeLessThanOrEqual(40);
    });

    it("keeps the highest-priority records when the budget is exceeded", () => {
      store.remember({ kind: "rejected", text: "low priority", filePath: "a.ts", source: "x" });
      store.remember({ kind: "convention", text: "high priority", filePath: "", source: "x" });
      const line = "- [convention] high priority";
      const result = store.forNeighborhood(["a.ts"], [], approximateTokens(line));
      expect(result.records.map((r) => r.text)).toEqual(["high priority"]);
      expect(result.tokens).toBe(approximateTokens(line));
    });

    it("is exact at the budget boundary", () => {
      store.remember({ kind: "accepted_fix", text: "exact", filePath: "a.ts", source: "x" });
      const line = "- [accepted_fix] exact (a.ts)";
      const needed = approximateTokens(line);
      expect(store.forNeighborhood(["a.ts"], [], needed).records).toHaveLength(1);
      expect(store.forNeighborhood(["a.ts"], [], needed - 1).records).toHaveLength(0);
    });

    it("uses 300 tokens as the default budget", () => {
      for (let i = 0; i < 200; i++) {
        store.remember({
          kind: "accepted_fix",
          text: `item ${i} with some words`,
          filePath: "a.ts",
          source: "x",
        });
      }
      const result = store.forNeighborhood(["a.ts"], []);
      expect(result.tokens).toBeLessThanOrEqual(300);
      expect(result.tokens).toBeGreaterThan(250);
    });

    it("returns nothing when there are no files or symbols", () => {
      store.remember({ kind: "accepted_fix", text: "x", filePath: "a.ts", source: "x" });
      expect(store.forNeighborhood([], [], 300)).toEqual({ records: [], tokens: 0 });
    });

    it("rejects an invalid budget", () => {
      expect(ERROR_CODE(() => store.forNeighborhood(["a.ts"], [], -5))).toBe("invalid_budget");
      expect(ERROR_CODE(() => store.forNeighborhood(["a.ts"], [], 1.5))).toBe("invalid_budget");
    });

    it("applies a directory-scoped convention to files under that directory only", () => {
      store.remember({
        kind: "convention",
        text: "memory rule",
        filePath: "packages/memory/",
        source: "p",
      });
      expect(store.forNeighborhood(["packages/memory/src/a.ts"], [], 300).records).toHaveLength(1);
      expect(store.forNeighborhood(["packages/other/a.ts"], [], 300).records).toHaveLength(0);
    });
  });

  describe("importConventions", () => {
    function agents(content: string, relative = "AGENTS.md"): void {
      dir.file(relative, content);
    }

    it("stores each AGENTS.md section as a convention once", () => {
      const repo = makeTempDir();
      try {
        repo.file("AGENTS.md", "# Guide\n\nIntro.\n\n## Build\n\nRun build.\n");
        const first = store.importConventions(repo.path);
        expect(first).toEqual({ added: 2, unchanged: 0, removed: 0, skippedSecret: 0 });
        expect(store.list({ kind: "convention" })).toHaveLength(2);
        expect(store.list({ kind: "convention" }).every((r) => r.source === "AGENTS.md")).toBe(
          true,
        );
      } finally {
        repo.cleanup();
      }
    });

    it("does not duplicate conventions on repeated imports", () => {
      const repo = makeTempDir();
      try {
        repo.file("AGENTS.md", "## Build\n\nRun build.\n\n## Test\n\nRun test.\n");
        store.importConventions(repo.path);
        const again = store.importConventions(repo.path);
        expect(again).toEqual({ added: 0, unchanged: 2, removed: 0, skippedSecret: 0 });
        expect(store.list({ kind: "convention" })).toHaveLength(2);
      } finally {
        repo.cleanup();
      }
    });

    it("replaces a convention whose section changed and removes one that was deleted", () => {
      const repo = makeTempDir();
      try {
        repo.file("AGENTS.md", "## Build\n\nRun build.\n\n## Test\n\nRun test.\n");
        store.importConventions(repo.path);
        repo.file("AGENTS.md", "## Build\n\nRun build with bun.\n");
        const result = store.importConventions(repo.path);
        expect(result).toEqual({ added: 1, unchanged: 0, removed: 2, skippedSecret: 0 });
        const texts = store.list({ kind: "convention" }).map((r) => r.text);
        expect(texts).toContain("## Build\n\nRun build with bun.");
        expect(texts.some((t) => t.includes("Run test."))).toBe(false);
      } finally {
        repo.cleanup();
      }
    });

    it("skips sections that contain secrets and counts them", () => {
      const repo = makeTempDir();
      try {
        repo.file(
          "AGENTS.md",
          "## Build\n\nRun build.\n\n## Deploy\n\nUse AKIAABCDEFGHIJKLMNOP.\n",
        );
        const result = store.importConventions(repo.path);
        expect(result).toEqual({ added: 1, unchanged: 0, removed: 0, skippedSecret: 1 });
        expect(store.list().some((r) => r.text.includes("AKIA"))).toBe(false);
      } finally {
        repo.cleanup();
      }
    });

    it("imports nested AGENTS.md files with their directory as scope and skips node_modules", () => {
      const repo = makeTempDir();
      try {
        repo.file("packages/memory/AGENTS.md", "## Testing\n\nUse vitest.\n");
        repo.file("node_modules/pkg/AGENTS.md", "## Ignored\n\nNot ours.\n");
        const result = store.importConventions(repo.path);
        expect(result.added).toBe(1);
        const [record] = store.list({ kind: "convention" });
        expect(record?.filePath).toBe("packages/memory/");
        expect(record?.source).toBe("packages/memory/AGENTS.md");
      } finally {
        repo.cleanup();
      }
    });

    it("rejects a root that is not a directory", () => {
      const repo = makeTempDir();
      try {
        const file = repo.file("AGENTS.md", "## A\n\nB.\n");
        expect(ERROR_CODE(() => store.importConventions(file))).toBe("invalid_path");
      } finally {
        repo.cleanup();
      }
    });
  });

  describe("local only", () => {
    it("does not reference any network API in its source", () => {
      const srcDir = join(__dirname, "..", "src");
      const banned = /node:(http|https|net|tls|dgram|dns)\b|\bfetch\(|WebSocket|XMLHttpRequest/;
      for (const name of readdirSync(srcDir)) {
        expect(readFileSync(join(srcDir, name), "utf8")).not.toMatch(banned);
      }
    });
  });
});
