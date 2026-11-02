import {
  type AgentApp,
  type ClientApp,
  type SessionUpdate,
  client,
  methods,
} from "@agentclientprotocol/sdk";
import type { AcpHandler, ProgressReporter, TaskRequest, TaskResult } from "../src/index.js";

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export interface RecordedTask {
  readonly task: TaskRequest;
  readonly signal: AbortSignal;
}

export type RunTaskFn = (
  task: TaskRequest,
  progress: ProgressReporter,
  signal: AbortSignal,
) => Promise<TaskResult>;

/** A handler that records every call and delegates to `run`. */
export function recordingHandler(run: RunTaskFn): { handler: AcpHandler; calls: RecordedTask[] } {
  const calls: RecordedTask[] = [];
  const handler: AcpHandler = {
    runTask(task, progress, signal) {
      calls.push({ task, signal });
      return run(task, progress, signal);
    },
  };
  return { handler, calls };
}

/** The client-side context that `ClientApp.connectWith` passes to its callback. */
export type ClientCtx = Parameters<Parameters<ClientApp["connectWith"]>[1]>[0];

/**
 * Connects an SDK client to `agent` over the SDK's in-memory stream pair and
 * runs `op`. Session updates the agent sends are collected in arrival order.
 */
export function withClient<T>(
  agent: AgentApp,
  op: (ctx: ClientCtx, updates: SessionUpdate[]) => Promise<T>,
): Promise<T> {
  const updates: SessionUpdate[] = [];
  const clientApp = client({ name: "test-client" });
  clientApp.onNotification(methods.client.session.update, ({ params }) => {
    updates.push(params.update);
  });
  return clientApp.connectWith(agent, (ctx) => op(ctx, updates));
}
