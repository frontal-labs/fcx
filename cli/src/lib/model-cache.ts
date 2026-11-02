/**
 * The model host cache for one `fcx acp` process (plan §6.1, §11.2). One host per generation model id, reused by
 * every prompt in the process. One-shot CLI commands never use it: they create and shut down their own host.
 *
 * Idle unload: once no prompt is running, a host that has not been used for `idleUnloadMs` is shut down and
 * dropped. The next prompt that needs it loads it again. The clock is an injected scheduler, so tests run
 * without waiting.
 *
 * Shutdown: `closeAll` stops every idle timer and shuts every host down. The ACP command calls it when the
 * connection ends and on SIGINT and SIGTERM.
 */
import type { FcSettings } from "@fcx/config";
import type { ModelHost } from "@fcx/model";

/** plan §6.1: unload the generation model after `fc.idleUnloadMinutes`, default 15. */
export const DEFAULT_IDLE_UNLOAD_MINUTES = 15;

/** The default model setting. It means "the tier's default model", so it shares one cache entry. */
const DEFAULT_MODEL_KEY = "ggml/auto";

/** Runs `callback` after `ms`. Returns a function that cancels it. */
export interface IdleScheduler {
  schedule(callback: () => void, ms: number): () => void;
}

/** The real clock. The timer is unref'd so it never keeps the process alive by itself. */
export const systemScheduler: IdleScheduler = {
  schedule(callback, ms) {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export interface ModelHostCacheOptions {
  /** Creates a new host for the settings. Called once per model id until that host is unloaded. */
  readonly create: (settings: FcSettings) => Promise<ModelHost>;
  readonly idleUnloadMs: number;
  readonly scheduler?: IdleScheduler;
}

interface Entry {
  readonly host: Promise<ModelHost>;
  cancelIdle: (() => void) | undefined;
}

export class ModelHostCache {
  private readonly entries = new Map<string, Entry>();
  private readonly scheduler: IdleScheduler;
  private activePrompts = 0;
  private closed = false;

  constructor(private readonly options: ModelHostCacheOptions) {
    this.scheduler = options.scheduler ?? systemScheduler;
  }

  /** The host for these settings. Creates it on first use. Throws after `closeAll`. */
  get(settings: FcSettings): Promise<ModelHost> {
    if (this.closed) return Promise.reject(new Error("the model host cache is closed"));
    const key = modelKey(settings);
    let entry = this.entries.get(key);
    if (entry === undefined) {
      const created: Entry = { host: this.options.create(settings), cancelIdle: undefined };
      entry = created;
      this.entries.set(key, created);
      // A host that failed to load is not kept, so the next prompt tries again.
      created.host.catch(() => {
        if (this.entries.get(key) === created) this.entries.delete(key);
      });
    }
    this.armIdle(key, entry);
    return entry.host;
  }

  /** Marks a prompt as running. No host is unloaded while one is. */
  beginPrompt(): void {
    this.activePrompts++;
    for (const entry of this.entries.values()) this.disarm(entry);
  }

  /** Marks a prompt as finished. When none is left, every host starts its idle clock. */
  endPrompt(): void {
    this.activePrompts = Math.max(0, this.activePrompts - 1);
    if (this.activePrompts > 0) return;
    for (const [key, entry] of this.entries) this.armIdle(key, entry);
  }

  /** The model ids that currently have a loaded or loading host. For tests and diagnostics. */
  loadedModels(): string[] {
    return [...this.entries.keys()];
  }

  /** Stops every timer and shuts every host down. Later `get` calls reject. */
  async closeAll(): Promise<void> {
    this.closed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) this.disarm(entry);
    await Promise.all(entries.map((entry) => shutdownQuietly(entry.host)));
  }

  private armIdle(key: string, entry: Entry): void {
    this.disarm(entry);
    if (this.activePrompts > 0) return;
    entry.cancelIdle = this.scheduler.schedule(() => {
      entry.cancelIdle = undefined;
      if (this.activePrompts > 0 || this.entries.get(key) !== entry) return;
      this.entries.delete(key);
      void shutdownQuietly(entry.host);
    }, this.options.idleUnloadMs);
  }

  private disarm(entry: Entry): void {
    entry.cancelIdle?.();
    entry.cancelIdle = undefined;
  }
}

/** The cache key: the generation model id. The default setting and an unset value are the same host. */
export function modelKey(settings: FcSettings): string {
  return settings.model === undefined || settings.model === DEFAULT_MODEL_KEY
    ? DEFAULT_MODEL_KEY
    : settings.model;
}

/**
 * The idle unload delay in milliseconds, from the `fc` settings block (`fc.idleUnloadMinutes`). A missing,
 * non-numeric or non-positive value means the default of 15 minutes.
 */
export function idleUnloadMsFrom(fc: unknown): number {
  const raw =
    typeof fc === "object" && fc !== null && "idleUnloadMinutes" in fc
      ? fc.idleUnloadMinutes
      : undefined;
  const minutes =
    typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_UNLOAD_MINUTES;
  return minutes * 60_000;
}

async function shutdownQuietly(host: Promise<ModelHost>): Promise<void> {
  try {
    await (await host).shutdown();
  } catch {
    // A host that never loaded, or that fails to unload, has nothing left to free.
  }
}
