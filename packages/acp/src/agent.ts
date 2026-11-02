/**
 * ACP agent side for fcx (Agent Client Protocol, stable v1, via
 * `@agentclientprotocol/sdk@2.2.0`).
 *
 * Security boundary (PLAN.md section 2, rule 1):
 * - This package never reads or writes files, never runs terminals, and never
 *   calls the client's fs or terminal methods. It advertises no file-system or
 *   terminal client capabilities and does not request them.
 * - It never changes the permission mode. `session/set_mode` and
 *   `session/set_config_option` are not implemented, so the SDK answers them
 *   with "method not found".
 * - It only forwards each prompt's text, session id, and cwd to the injected
 *   `AcpHandler`. All edits happen inside the handler, which is the CLI's job.
 *
 * Capabilities advertised: `initialize` and `session/new` (cwd-bound sessions),
 * `session/prompt` (text only, streaming progress, stop reasons), and
 * `session/cancel`. Authentication, session load/list/resume, MCP servers, and
 * extra workspace directories are not supported and are rejected.
 */
import { isAbsolute } from "node:path";
import {
  type AgentApp,
  type AgentCapabilities,
  PROTOCOL_VERSION,
  RequestError,
  type SessionUpdate,
  type StopReason,
  agent,
  methods,
} from "@agentclientprotocol/sdk";
import { assertHandler, errorMessage, isTaskStopReason } from "./handler.js";
import { type ActiveTurn, SessionStore, promptText } from "./session.js";
import type { AcpAgentOptions, ProgressReporter, TaskResult, TaskStopReason } from "./types.js";

/** The ACP agent returned by `createAcpAgent`. */
export type AcpAgent = AgentApp;

const AGENT_CAPABILITIES: AgentCapabilities = {
  loadSession: false,
  promptCapabilities: { image: false, audio: false, embeddedContext: false },
  mcpCapabilities: { http: false, sse: false },
};

/** Error code for "Resource not found" (ACP session id unknown). */
const RESOURCE_NOT_FOUND = -32002;

/**
 * Builds an ACP agent that forwards each prompt to `options.handler`.
 * Throws `AcpConfigError` if the handler is missing `runTask`.
 */
export function createAcpAgent(options: AcpAgentOptions): AcpAgent {
  assertHandler(options.handler);
  const handler = options.handler;
  const sessions = new SessionStore();

  const app = agent({ name: options.name ?? "fcx-acp" });

  app.onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: AGENT_CAPABILITIES,
    authMethods: [],
  }));

  app.onRequest(methods.agent.session.new, ({ params }) => {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(undefined, "cwd must be an absolute path");
    }
    if (params.mcpServers.length > 0) {
      throw RequestError.invalidParams(undefined, "MCP servers are not supported");
    }
    if ((params.additionalDirectories ?? []).length > 0) {
      throw RequestError.invalidParams(undefined, "additional directories are not supported");
    }
    const record = sessions.create(params.cwd);
    return { sessionId: record.id };
  });

  app.onRequest(methods.agent.session.prompt, async ({ params, client, signal }) => {
    const record = sessions.get(params.sessionId);
    if (!record) {
      throw new RequestError(RESOURCE_NOT_FOUND, "Resource not found", {
        sessionId: params.sessionId,
      });
    }
    if (record.activeTurn) {
      throw RequestError.invalidRequest(undefined, "session already has an active prompt");
    }
    const text = promptText(params.prompt);
    if (text.length === 0) {
      throw RequestError.invalidParams(undefined, "prompt must contain text");
    }

    const turn: ActiveTurn = { controller: new AbortController(), cancelled: false };
    record.activeTurn = turn;
    const cancel = (): void => cancelTurn(turn);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();

    const sessionId = record.id;
    // Progress notifications are chained so they reach the client in call order,
    // and all of them are sent before the prompt response.
    let chain: Promise<void> = Promise.resolve();
    let reporting = true;
    const notifyUpdate = (update: SessionUpdate): void => {
      if (!reporting) return;
      chain = chain
        .then(() => client.notify(methods.client.session.update, { sessionId, update }))
        .catch(() => undefined);
    };

    const progress: ProgressReporter = (update) => {
      notifyUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: `${update.kind}: ${update.message}` },
      });
    };

    try {
      const result = await runTurn(
        () =>
          handler.runTask({ sessionId, cwd: record.cwd, text }, progress, turn.controller.signal),
        turn,
      );

      reporting = false;
      await chain;
      if (result.summary.length > 0) {
        try {
          await client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: result.summary },
            },
          });
        } catch {
          // The connection closed before the summary could be delivered.
        }
      }
      return { stopReason: toWireStopReason(result.stopReason, result.summary) };
    } finally {
      reporting = false;
      signal.removeEventListener("abort", cancel);
      record.activeTurn = undefined;
    }
  });

  app.onNotification(methods.agent.session.cancel, ({ params }) => {
    const record = sessions.get(params.sessionId);
    if (record?.activeTurn) cancelTurn(record.activeTurn);
  });

  return app;
}

/**
 * Maps a handler stop reason to the ACP `PromptResponse.stopReason` field. ACP v1 defines no "error"
 * stop reason, so a failed task is reported as a JSON-RPC internal error instead.
 */
function toWireStopReason(reason: TaskStopReason, summary: string): StopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "cancelled":
      return "cancelled";
    case "error":
      throw RequestError.internalError({ summary }, "the task failed");
    default:
      throw RequestError.internalError(
        { reason: String(reason) },
        "the handler returned an unknown stop reason",
      );
  }
}

function cancelTurn(turn: ActiveTurn): void {
  turn.cancelled = true;
  turn.controller.abort();
}

/**
 * Runs the handler and resolves with its result. If the turn is cancelled, the
 * result is "cancelled" without waiting for the handler to finish. Handler
 * failures become stopReason "error" rather than a broken connection.
 */
async function runTurn(run: () => Promise<TaskResult>, turn: ActiveTurn): Promise<TaskResult> {
  const cancelled = new Promise<TaskResult>((resolve) => {
    turn.controller.signal.addEventListener(
      "abort",
      () => resolve({ stopReason: "cancelled", summary: "" }),
      { once: true },
    );
  });

  let outcome: TaskResult;
  try {
    outcome = await Promise.race([Promise.resolve().then(run), cancelled]);
  } catch (error) {
    outcome = { stopReason: "error", summary: errorMessage(error) };
  }

  if (turn.cancelled) {
    return { stopReason: "cancelled", summary: outcome.summary };
  }
  if (!isTaskStopReason(outcome.stopReason)) {
    return { stopReason: "error", summary: "handler returned an unknown stop reason" };
  }
  return outcome;
}
