import type { GlobalArgs } from "../args.js";
import { setProtocolMode } from "../lib/approval.js";

/**
 * Sends console output to stderr. The protocol owns stdout, so any stray log line must never reach it.
 * Exported so tests can check it; the restore is the caller's job.
 */
export function routeConsoleToStderr(): void {
  const toErr = (...parts: unknown[]): void => console.error(...parts);
  console.log = toErr;
  console.info = toErr;
  console.debug = toErr;
}

/**
 * `fcx acp`: serves the ACP agent over stdin and stdout until the client disconnects. stdout carries protocol
 * frames only. Interactive prompts decline for the whole process (protocol mode), and each prompt runs through
 * the handler in lib/acp-handler.ts.
 *
 * The process owns one model host cache (lib/model-cache.ts). It is shut down when the connection ends and on
 * SIGINT or SIGTERM. One-shot commands never see the cache.
 */
export async function runAcpCli(args: GlobalArgs): Promise<number> {
  if (args.rest.length > 0) {
    console.error("usage: fcx acp");
    return 1;
  }
  const { createAcpAgent, serveStdio } = await import("@fcx/acp");
  const { createAcpHandler } = await import("../lib/acp-handler.js");
  const { ModelHostCache, idleUnloadMsFrom } = await import("../lib/model-cache.js");
  const { createFreshModelHost, useSharedModelCache } = await import("../lib/runtime.js");
  const { resolveConfig } = await import("@fcx/config");

  setProtocolMode(true);
  routeConsoleToStderr();

  const resolved = resolveConfig(args.cwd, { permissionMode: args.permissionMode });
  const models = new ModelHostCache({
    create: createFreshModelHost,
    idleUnloadMs: idleUnloadMsFrom(resolved.settings.fc),
  });
  useSharedModelCache(models);

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= models.closeAll();
    return stopping;
  };
  const exitCodes: ReadonlyArray<readonly [NodeJS.Signals, number]> = [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ];
  const onSignal = (code: number) => (): void => {
    void stop().finally(() => process.exit(code));
  };
  const handlers = exitCodes.map(([signal, code]) => {
    const handler = onSignal(code);
    process.on(signal, handler);
    return [signal, handler] as const;
  });

  try {
    await serveStdio(createAcpAgent({ handler: createAcpHandler({ models }), name: "fcx" }));
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    useSharedModelCache(undefined);
    await stop();
  }
  return 0;
}
