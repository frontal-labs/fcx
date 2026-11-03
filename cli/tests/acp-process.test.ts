/**
 * Conformance test with a real process. It spawns the built CLI (`node cli/dist/main.js acp`) and drives it over
 * stdio with the official ACP client from @agentclientprotocol/sdk.
 *
 * The suite builds cli/dist itself before it runs, so it never spawns a missing or stale bundle.
 *
 * The model is scripted. The child gets NODE_ENV=test and FCX_TEST_SCRIPTED_MODEL=<script file>, which the
 * factory in src/lib/runtime.ts honours only under NODE_ENV=test (see src/lib/scripted-model.ts).
 *
 * The client is imported from the package install under packages/acp, because cli/ does not declare the SDK.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// The client SDK is installed for packages/acp only. Import it by path, not by bare specifier.
import * as sdk from "@agentclientprotocol/sdk";

const CLI_DIR = fileURLToPath(new URL("..", import.meta.url));
const CLI_ENTRY = fileURLToPath(new URL("../dist/main.js", import.meta.url));

beforeAll(() => {
  const built = spawnSync("bun", ["run", "build"], { cwd: CLI_DIR, encoding: "utf8" });
  if (built.status !== 0) {
    throw new Error(`cli build failed:\n${built.stdout}\n${built.stderr}`);
  }
}, 120_000);

const SOURCE = [
  "export function total(values: number[]): number {",
  "  return values.reduce((sum, value) => sum + value, 0);",
  "}",
  "",
].join("\n");

/** The router's answer, then the explain answer. Its claim cites lines 1-2, and its identifiers appear there. */
const SCRIPT = [
  { recipe: "explain", target: "src/a.ts:1-3" },
  {
    summary: "Sums a list of numbers.",
    claims: [
      {
        text: "`total` sums the list with `reduce`.",
        cites: [{ file: "src/a.ts", start: 1, end: 2 }],
      },
    ],
  },
];

interface Harness {
  root: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
  scriptPath: string;
}

let harness: Harness;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "fcx-acp-process-"));
  const workspace = join(root, "ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "a.ts"), SOURCE);
  writeFileSync(
    join(workspace, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src"] }),
  );
  const configHome = join(root, "config-home");
  mkdirSync(configHome);
  const scriptPath = join(root, "script.json");
  writeFileSync(scriptPath, JSON.stringify(SCRIPT));
  harness = {
    root,
    workspace,
    scriptPath,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      NODE_ENV: "test",
      FCX_TEST_SCRIPTED_MODEL: scriptPath,
      FRONTAL_CODE_CONFIG_HOME: configHome,
      FRONTAL_CODE_CACHE_DIR: join(root, "cache"),
    },
  };
});

afterEach(() => {
  rmSync(harness.root, { recursive: true, force: true });
});

interface Session {
  readonly child: ChildProcess;
  readonly streams: {
    readonly input: WritableStream<Uint8Array>;
    readonly output: ReadableStream<Uint8Array>;
  };
  readonly stdoutLines: () => string[];
  readonly stderr: () => string;
  readonly exited: Promise<number | null>;
}

/** Starts `fcx acp` with the test environment. stdout is captured raw and also fed to the SDK client. */
function startAgent(): Session {
  const child = spawn(process.execPath, [CLI_ENTRY, "acp"], {
    env: harness.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const raw: Buffer[] = [];
  const errors: Buffer[] = [];
  const tee = new PassThrough();
  child.stdout.on("data", (chunk: Buffer) => {
    raw.push(chunk);
    tee.write(chunk);
  });
  child.stdout.on("end", () => tee.end());
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
  });
  return {
    child,
    streams: {
      input: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      output: Readable.toWeb(tee) as ReadableStream<Uint8Array>,
    },
    stdoutLines: () =>
      Buffer.concat(raw)
        .toString("utf8")
        .split("\n")
        .filter((line) => line.length > 0),
    stderr: () => Buffer.concat(errors).toString("utf8"),
    exited,
  };
}

function textOf(content: unknown): string | undefined {
  return typeof content === "object" &&
    content !== null &&
    "type" in content &&
    content.type === "text" &&
    "text" in content &&
    typeof content.text === "string"
    ? content.text
    : undefined;
}

describe("fcx acp as a real process", () => {
  it("initializes, opens a session, streams progress, ends the turn, and keeps stdout to protocol lines", async () => {
    const session = startAgent();
    const updates: sdk.SessionUpdate[] = [];
    const app = sdk
      .client({ name: "fcx-process-test" })
      .onNotification(sdk.methods.client.session.update, ({ params }) => {
        updates.push(params.update);
      });

    const outcome = await app.connectWith(
      sdk.ndJsonStream(session.streams.input, session.streams.output),
      async (ctx) => {
        const init = await ctx.request(sdk.methods.agent.initialize, {
          protocolVersion: sdk.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const created = await ctx.request(sdk.methods.agent.session.new, {
          cwd: harness.workspace,
          mcpServers: [],
        });
        const prompt = await ctx.request(sdk.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: "explain src/a.ts:1-3" }],
        });
        return { init, prompt };
      },
    );

    expect(outcome.init.protocolVersion).toBe(sdk.PROTOCOL_VERSION);
    expect(outcome.prompt.stopReason).toBe("end_turn");

    const progress = updates.flatMap((u) =>
      u.sessionUpdate === "agent_thought_chunk" ? [textOf(u.content) ?? ""] : [],
    );
    for (const kind of ["route:", "run:", "check:", "result:"]) {
      expect(
        progress.some((text) => text.startsWith(kind)),
        kind,
      ).toBe(true);
    }
    const answer = updates.flatMap((u) =>
      u.sessionUpdate === "agent_message_chunk" ? [textOf(u.content) ?? ""] : [],
    );
    expect(answer.join("\n")).toContain("answered");

    // Closing stdin ends the connection, which must end the process cleanly.
    session.child.stdin?.end();
    expect(await session.exited, session.stderr()).toBe(0);

    // stdout carries protocol frames only: every non-empty line is a JSON-RPC message.
    const lines = session.stdoutLines();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
    }
  }, 60_000);

  it("refuses a relative cwd with a protocol error and stays up", async () => {
    const session = startAgent();
    const app = sdk.client({ name: "fcx-process-test" });
    await app.connectWith(
      sdk.ndJsonStream(session.streams.input, session.streams.output),
      async (ctx) => {
        await ctx.request(sdk.methods.agent.initialize, {
          protocolVersion: sdk.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        await expect(
          ctx.request(sdk.methods.agent.session.new, { cwd: "relative/dir", mcpServers: [] }),
        ).rejects.toThrow();
      },
    );
    session.child.stdin?.end();
    expect(await session.exited, session.stderr()).toBe(0);
  }, 60_000);
});
