import type { MemoryStore } from "@fcx/memory";

/**
 * Runs one write against the local memory database. Memory is advisory: a failure is returned as a
 * warning string and never thrown, so a fix or an undo can never fail because of it.
 */
export async function rememberSafely(
  memoryPath: string,
  write: (store: MemoryStore) => void,
): Promise<string | undefined> {
  let store: MemoryStore | undefined;
  try {
    const { openMemory } = await import("@fcx/memory");
    store = openMemory(memoryPath);
    write(store);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `memory not updated: ${message}`;
  } finally {
    try {
      store?.close();
    } catch {
      // Closing a database that was opened is not a memory failure worth reporting.
    }
  }
}
