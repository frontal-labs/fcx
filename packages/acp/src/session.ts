import { randomUUID } from "node:crypto";
import type { ContentBlock } from "@agentclientprotocol/sdk";

/** One in-flight `session/prompt` turn. */
export interface ActiveTurn {
  readonly controller: AbortController;
  /** Set once the client cancels the turn (or the request is cancelled). */
  cancelled: boolean;
}

/** A session created by `session/new`, bound to one working directory. */
export interface SessionRecord {
  readonly id: string;
  readonly cwd: string;
  activeTurn: ActiveTurn | undefined;
}

/** In-memory registry of sessions for one agent instance. */
export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  create(cwd: string): SessionRecord {
    const record: SessionRecord = { id: randomUUID(), cwd, activeTurn: undefined };
    this.sessions.set(record.id, record);
    return record;
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }
}

/**
 * Joins the text blocks of a prompt. Only text is accepted: the agent advertises
 * no image, audio, or embedded-context support, so other blocks are ignored.
 */
export function promptText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}
