import { GgmlNodeModelHost } from "./host.js";
import type { GgmlNodeModelHostOptions, ModelHost } from "./types.js";

export function createMockModelHost(opts: GgmlNodeModelHostOptions = {}): ModelHost {
  return new GgmlNodeModelHost({ ...opts, mock: true });
}
