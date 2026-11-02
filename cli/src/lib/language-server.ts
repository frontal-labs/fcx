import { LanguageServerPool, detectServers } from "@fcx/lsp";

/** One definition location, as the recipe context step expects it. Line and column are 1-based. */
export interface ServerDefinition {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/** Asks the server for the definitions of the symbol at a 1-based position. Rejects on any server error. */
export type DefinitionsAt = (
  file: string,
  line: number,
  column: number,
) => Promise<readonly ServerDefinition[]>;

/** A language server for one run. `close` must be called once the run is over. */
export interface LanguageServerSession {
  /** Undefined when no server is used. The context step then runs on the checker alone. */
  readonly definitionsAt?: DefinitionsAt;
  /** Why the server is or is not used, for the report. */
  readonly notes: readonly string[];
  readonly close: () => Promise<void>;
}

/**
 * Detects the TypeScript language server and opens a pool for it. The workspace's own node_modules is searched
 * only when `trusted` is true, and a server is used only when the workspace is trusted. The pool starts its
 * server on the first definition query, so a run that never needs context never spawns one.
 */
export async function openLanguageServer(
  workspace: string,
  trusted: boolean,
): Promise<LanguageServerSession> {
  const detected = await detectServers(workspace, { trustWorkspace: trusted });
  const typescript = detected.find((server) => server.language === "typescript");
  const none = async (): Promise<void> => {};

  if (!trusted) {
    return {
      notes: ["workspace is not trusted: language server not used"],
      close: none,
    };
  }
  if (typescript === undefined || !typescript.available) {
    return {
      notes: [
        `typescript language server unavailable: ${typescript?.available === false ? typescript.reason : "not detected"}`,
      ],
      close: none,
    };
  }

  const pool = new LanguageServerPool(workspace, { detect: { trustWorkspace: true } });
  return {
    definitionsAt: async (file, line, column) => {
      const outcome = await pool.definition(file, line, column);
      if (outcome.source === "unavailable") throw new Error(outcome.reason);
      return outcome.locations.map((location) => ({
        file: location.file,
        line: location.range.start.line,
        column: location.range.start.column,
      }));
    },
    notes: [],
    close: () => pool.shutdown(),
  };
}
