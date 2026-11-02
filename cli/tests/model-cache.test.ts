import type { FcSettings } from "@fcx/config";
import type { ModelHost } from "@fcx/model";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_IDLE_UNLOAD_MINUTES,
  type IdleScheduler,
  ModelHostCache,
  idleUnloadMsFrom,
  modelKey,
} from "../src/lib/model-cache.js";
import { createModelHost, useSharedModelCache } from "../src/lib/runtime.js";
import { ScriptedModelHost, scriptedModelFromEnv } from "../src/lib/scripted-model.js";

/** A host that counts how often it was shut down. */
class CountingHost extends ScriptedModelHost {
  shutdowns = 0;
  override async shutdown(): Promise<void> {
    this.shutdowns++;
  }
}

/** A scheduler the test fires by hand, so idle unload never waits on real time. */
function manualScheduler() {
  const pending = new Set<{ callback: () => void; cancelled: boolean }>();
  const scheduler: IdleScheduler = {
    schedule(callback) {
      const timer = { callback, cancelled: false };
      pending.add(timer);
      return () => {
        timer.cancelled = true;
        pending.delete(timer);
      };
    },
  };
  return {
    scheduler,
    pending: () => pending.size,
    fire: () => {
      for (const timer of [...pending]) {
        pending.delete(timer);
        if (!timer.cancelled) timer.callback();
      }
    },
  };
}

function setup(options: { failFirst?: boolean } = {}) {
  const timers = manualScheduler();
  const hosts: CountingHost[] = [];
  let calls = 0;
  const cache = new ModelHostCache({
    idleUnloadMs: 1000,
    scheduler: timers.scheduler,
    create: async () => {
      calls++;
      if (options.failFirst && calls === 1) throw new Error("cannot load");
      const host = new CountingHost([]);
      hosts.push(host);
      return host;
    },
  });
  return { cache, timers, hosts, created: () => calls };
}

const settings = (model?: string): FcSettings => ({ model });

afterEach(() => useSharedModelCache(undefined));

describe("ModelHostCache", () => {
  it("reuses one host for every prompt on the same model", async () => {
    const { cache, created } = setup();
    const first = await cache.get(settings("ggml/auto"));
    cache.beginPrompt();
    cache.endPrompt();
    const second = await cache.get(settings(undefined));
    expect(second).toBe(first);
    expect(created()).toBe(1);
  });

  it("keeps one host per model id", async () => {
    const { cache, created } = setup();
    const a = await cache.get(settings("ggml/a"));
    const b = await cache.get(settings("ggml/b"));
    expect(a).not.toBe(b);
    expect(created()).toBe(2);
    expect(cache.loadedModels().sort()).toEqual(["ggml/a", "ggml/b"]);
  });

  it("unloads an idle host after the delay, and loads it again on the next use", async () => {
    const { cache, timers, hosts, created } = setup();
    const first = await cache.get(settings());
    cache.beginPrompt();
    cache.endPrompt();
    expect(timers.pending()).toBe(1);
    timers.fire();
    await Promise.resolve();
    expect(hosts[0]?.shutdowns).toBe(1);
    expect(cache.loadedModels()).toEqual([]);
    const second = await cache.get(settings());
    expect(second).not.toBe(first);
    expect(created()).toBe(2);
  });

  it("never unloads while a prompt is running", async () => {
    const { cache, timers, hosts } = setup();
    await cache.get(settings());
    cache.beginPrompt();
    expect(timers.pending()).toBe(0);
    cache.endPrompt();
    // A second prompt started before the first ends keeps the clock stopped.
    cache.beginPrompt();
    cache.beginPrompt();
    cache.endPrompt();
    expect(timers.pending()).toBe(0);
    cache.endPrompt();
    expect(timers.pending()).toBe(1);
    timers.fire();
    await Promise.resolve();
    expect(hosts[0]?.shutdowns).toBe(1);
  });

  it("does not keep a host that failed to load", async () => {
    const { cache, created } = setup({ failFirst: true });
    await expect(cache.get(settings())).rejects.toThrow("cannot load");
    await Promise.resolve();
    expect(cache.loadedModels()).toEqual([]);
    await cache.get(settings());
    expect(created()).toBe(2);
  });

  it("shuts every host down on closeAll and refuses later requests", async () => {
    const { cache, timers, hosts } = setup();
    await cache.get(settings("ggml/a"));
    await cache.get(settings("ggml/b"));
    await cache.closeAll();
    expect(hosts.map((h) => h.shutdowns)).toEqual([1, 1]);
    expect(timers.pending()).toBe(0);
    await expect(cache.get(settings())).rejects.toThrow("closed");
  });

  it("gives the default and an unset model the same key", () => {
    expect(modelKey({})).toBe("ggml/auto");
    expect(modelKey({ model: "ggml/auto" })).toBe("ggml/auto");
    expect(modelKey({ model: "ggml/other" })).toBe("ggml/other");
  });
});

describe("idleUnloadMsFrom", () => {
  it("defaults to 15 minutes, as plan 6.1 says", () => {
    expect(DEFAULT_IDLE_UNLOAD_MINUTES).toBe(15);
    expect(idleUnloadMsFrom(undefined)).toBe(15 * 60_000);
    expect(idleUnloadMsFrom({})).toBe(15 * 60_000);
  });

  it("reads fc.idleUnloadMinutes and ignores invalid values", () => {
    expect(idleUnloadMsFrom({ idleUnloadMinutes: 2 })).toBe(120_000);
    expect(idleUnloadMsFrom({ idleUnloadMinutes: 0 })).toBe(15 * 60_000);
    expect(idleUnloadMsFrom({ idleUnloadMinutes: -3 })).toBe(15 * 60_000);
    expect(idleUnloadMsFrom({ idleUnloadMinutes: "5" })).toBe(15 * 60_000);
  });
});

describe("scripted model gate", () => {
  it("is ignored outside NODE_ENV=test", () => {
    expect(scriptedModelFromEnv({ FCX_TEST_SCRIPTED_MODEL: "/nonexistent.json" })).toBeUndefined();
    expect(
      scriptedModelFromEnv({
        NODE_ENV: "production",
        FCX_TEST_SCRIPTED_MODEL: "/nonexistent.json",
      }),
    ).toBeUndefined();
  });

  it("is ignored when the variable is empty", () => {
    expect(scriptedModelFromEnv({ NODE_ENV: "test", FCX_TEST_SCRIPTED_MODEL: "" })).toBeUndefined();
  });

  it("is honoured under NODE_ENV=test and returns outputs in order", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "fcx-script-"));
    const path = join(dir, "script.json");
    writeFileSync(path, JSON.stringify([{ n: 1 }, { n: 2 }]));
    const host: ModelHost | undefined = scriptedModelFromEnv({
      NODE_ENV: "test",
      FCX_TEST_SCRIPTED_MODEL: path,
    });
    expect(host).toBeDefined();
    expect(
      (await host?.generateObject<{ n: number }>({ schema: null, prompt: "" }))?.object,
    ).toEqual({ n: 1 });
    expect(
      (await host?.generateObject<{ n: number }>({ schema: null, prompt: "" }))?.object,
    ).toEqual({ n: 2 });
    await expect(host?.generateObject({ schema: null, prompt: "" })).rejects.toThrow("ran out");
  });

  it("is not used by the shared cache path unless a cache is installed", async () => {
    const { cache } = setup();
    useSharedModelCache(cache);
    const first = await createModelHost({});
    const second = await createModelHost({});
    expect(second).toBe(first);
    useSharedModelCache(undefined);
  });
});
