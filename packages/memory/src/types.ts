export const MEMORY_KINDS = ["accepted_fix", "rejected", "convention"] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface NewMemoryRecord {
  kind: MemoryKind;
  text: string;
  filePath?: string;
  symbol?: string;
  source: string;
}

export interface MemoryRecord {
  id: number;
  kind: MemoryKind;
  text: string;
  filePath: string | null;
  symbol: string | null;
  source: string;
  createdAt: number;
}

export interface MemoryFilter {
  kind?: MemoryKind;
  filePath?: string;
  symbol?: string;
}

export interface RecordInput {
  text: string;
  filePath?: string;
  symbol?: string;
  source?: string;
}

export interface NeighborhoodResult {
  records: MemoryRecord[];
  tokens: number;
}

export interface InstructionBlock {
  text: string;
  tokens: number;
  sources: string[];
}

export interface ImportResult {
  added: number;
  unchanged: number;
  removed: number;
  skippedSecret: number;
}
