import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/app.js";
import { type GlobalArgs, parseGlobalArgs } from "../src/args.js";
import {
  STOP_ARG,
  argvFromArgs,
  readWarmSettings,
  routeToWarmServer,
  sendWarmRequest,
  socketPathFor,
} from "../src/lib/client.js";
import { type ServeHandle, handleRequestLine, startServer } from "../src/lib/serve.js";
import { type Sandbox, captureLog, makeSandbox } from "./support.js";

describe("warm server", () => {
  let sb: Sandbox;
  let socketPath: string;
  let handles: ServeHandle[];
  let savedWarm: string | undefined;

  beforeEach(() => {
    sb = makeSandbox("fcx-serve-");
    socketPath = socketPathFor(sb.cache);
    handles = [];
    savedWarm = process.env.FCX_WARM;
    Reflect.deleteProperty(process.env, "FCX_WARM");
  });

  afterEach(async () => {
    for (const handle of handles) await handle.stop();
    if (savedWarm === undefined) Reflect.deleteProperty(process.env, "FCX_WARM");
    else process.env.FCX_WARM = savedWarm;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    sb.cleanup();
  });

  async function serve(idleMs = 60_000): Promise<ServeHandle> {
    const handle = await startServer({ socketPath, idleMs });
    handles.push(handle);
    return handle;
  }

  async function request(argv: string[], cwd = sb.workspace) {
    const outcome = await sendWarmRequest(socketPath, { id: "t1", argv, cwd }, 1000);
    return outcome.kind === "response" ? outcome.response : undefined;
  }

  it("answers status with the same output the in-process run prints", async () => {
    await serve();
    const args = parseGlobalArgs(["-C", sb.workspace, "status"]);
    const direct = await captureLog(() => run(args));

    const response = await request(argvFromArgs(args));

    expect(response?.exitCode).toBe(direct.code);
    expect(response?.stdout).toBe(`${direct.lines.join("\n")}\n`);
    expect(response?.stderr).toBe("");
  });

  it("matches the in-process JSON output as well", async () => {
    await serve();
    const args = parseGlobalArgs(["--output-format", "json", "-C", sb.workspace, "status"]);
    const direct = await captureLog(() => run(args));

    const response = await request(argvFromArgs(args));

    expect(response?.stdout).toBe(`${direct.lines.join("\n")}\n`);
  });

  it("refuses serve", async () => {
    await serve();
    const response = await request(["serve"]);
    expect(response?.exitCode).toBe(1);
    expect(response?.stderr).toContain("serve cannot run through the warm server");
  });

  it("refuses a relative cwd", async () => {
    await serve();
    const response = await request(["status"], "relative/dir");
    expect(response?.exitCode).toBe(1);
    expect(response?.stderr).toContain("absolute");
  });

  it("refuses a cwd that does not exist", async () => {
    await serve();
    const response = await request(["status"], join(sb.root, "missing"));
    expect(response?.exitCode).toBe(1);
    expect(response?.stderr).toContain("existing absolute directory");
  });

  it("refuses a relative -C in the argv", async () => {
    await serve();
    const response = await request(["-C", "relative", "status"]);
    expect(response?.exitCode).toBe(1);
    expect(response?.stderr).toContain("-C must be");
  });

  it("refuses __stop__ when it is not the whole request", async () => {
    await serve();
    const response = await request(["status", STOP_ARG]);
    expect(response?.exitCode).toBe(1);
  });

  it("answers an invalid request line without running anything", async () => {
    const { response, stop } = await handleRequestLine("not json");
    expect(response.exitCode).toBe(1);
    expect(response.id).toBeNull();
    expect(stop).toBe(false);
  });

  it("creates the socket with mode 0600 in a 0700 run directory", async () => {
    await serve();
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(sb.cache, "run")).mode & 0o777).toBe(0o700);
  });

  it("replaces a stale socket left by a dead process", async () => {
    mkdirSync(join(sb.cache, "run"), { recursive: true });
    // A child that binds the socket and is killed before it can unlink it leaves a stale file behind.
    const bind = `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => process.kill(process.pid, "SIGKILL"));`;
    spawnSync(process.execPath, ["-e", bind]);
    expect(lstatSync(socketPath).isSocket()).toBe(true);

    await serve();
    const response = await request(["-C", sb.workspace, "status"]);
    expect(response?.exitCode).toBe(0);
  });

  it("refuses to start while another server answers", async () => {
    await serve();
    await expect(startServer({ socketPath, idleMs: 60_000 })).rejects.toThrow(/already running/);
  });

  it("exits on its own after the idle timeout and removes the socket", async () => {
    const handle = await startServer({ socketPath, idleMs: 50 });
    await handle.closed;
    expect(existsSync(socketPath)).toBe(false);
  });

  it("stops on the stop request after answering it", async () => {
    const handle = await serve();
    const response = await request([STOP_ARG]);
    expect(response?.exitCode).toBe(0);
    await handle.closed;
    expect(existsSync(socketPath)).toBe(false);
  });

  it("falls back to in-process when no socket exists", async () => {
    expect(await request(["status"])).toBeUndefined();

    vi.stubEnv("FCX_WARM", "1");
    const args = parseGlobalArgs(["-C", sb.workspace, "status"]);
    const { code, lines } = await captureLog(() => run(args));
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("permission mode:");
  });

  it("routes the command through the warm server when FCX_WARM=1", async () => {
    await serve();
    vi.stubEnv("FCX_WARM", "1");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const args = parseGlobalArgs(["-C", sb.workspace, "status"]);

    const exitCode = await routeToWarmServer(args);

    expect(exitCode).toBe(0);
    const printed = write.mock.calls.map((call) => String(call[0])).join("");
    expect(printed).toContain("permission mode:");
  });

  it("does not route when warm mode is off", async () => {
    await serve();
    const args: GlobalArgs = parseGlobalArgs(["-C", sb.workspace, "status"]);
    expect(await routeToWarmServer(args)).toBeUndefined();
  });

  it("reads warm settings with defaults for invalid values", () => {
    expect(readWarmSettings({})).toEqual({ enabled: false, idleExitMinutes: 15 });
    expect(readWarmSettings({ fc: { warmServer: true, idleExitMinutes: 0 } })).toEqual({
      enabled: true,
      idleExitMinutes: 15,
    });
    expect(readWarmSettings({ fc: { warmServer: true, idleExitMinutes: 2 } })).toEqual({
      enabled: true,
      idleExitMinutes: 2,
    });
  });
});

describe("sendWarmRequest outcomes", () => {
  it("reports unavailable when nothing listens on the socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fcx-warm-none-"));
    try {
      const outcome = await sendWarmRequest(
        join(dir, "fc.sock"),
        { id: "x", argv: ["status"], cwd: dir },
        200,
      );
      expect(outcome).toEqual({ kind: "unavailable" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports lost when the connection drops after the request was written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fcx-warm-lost-"));
    const socketPath = join(dir, "fc.sock");
    const server = createServer((socket) => {
      socket.on("data", () => socket.destroy());
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    try {
      const outcome = await sendWarmRequest(
        socketPath,
        { id: "x", argv: ["status"], cwd: dir },
        1000,
      );
      expect(outcome).toEqual({ kind: "lost" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
