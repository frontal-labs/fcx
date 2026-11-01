export interface ModelRegistryEntry {
  id: string;
  path?: string;
  sha256?: string;
  ctx: number;
  kind: "generation" | "embedding";
  tier: "S" | "M";
  license: string;
  quant?: string;
}

export interface ModelAlias {
  alias: string;
  target: string;
}

export interface ModelEvent {
  type: "load";
  model: string;
  ms: number;
}

export interface ModelRequestEvent {
  type: "request";
  model: string;
  ms: number;
}

export interface ModelErrorEvent {
  type: "error";
  model: string;
  error: string;
}

export type ModelHostEvent = ModelEvent | ModelRequestEvent | ModelErrorEvent;

export class ModelError extends Error {
  readonly code: string;
  readonly hint?: string;
  constructor(message: string, code = "MODEL_ERROR", hint?: string) {
    super(message);
    this.name = "ModelError";
    this.code = code;
    this.hint = hint;
  }
}

export class ModelLoadError extends ModelError {
  constructor(message: string, hint?: string) {
    super(message, "MODEL_LOAD_ERROR", hint);
    this.name = "ModelLoadError";
  }
}

export interface ModelHost {
  generateObject<T>(req: {
    schema: unknown;
    prompt: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ object: T; ms: number; raw: string }>;
  generateText(req: {
    prompt: string;
    temperature?: number;
    maxTokens?: number;
    stop?: string[];
    signal?: AbortSignal;
  }): Promise<{ text: string; ms: number }>;
  embed(input: string[]): Promise<{ embeddings: number[][]; dimensions: number; ms: number }>;
  countTokens(text: string): number;
  info(): { genModel: string; embedModel: string; ctx: number; rssMb: number };
  shutdown(): Promise<void>;
  onEvent?: (event: ModelHostEvent) => void;
}

export interface GgmlNodeModelHostOptions {
  genModel?: string;
  embedModel?: string;
  mock?: boolean;
}
