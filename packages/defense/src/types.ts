export type LayerName = "constrain" | "ground" | "anchor" | "verify" | "cite";

export type LayerOutcome =
  | { layer: LayerName; pass: true; ms: number }
  | {
      layer: LayerName;
      pass: false;
      ms: number;
      reasonCode: string;
      /** Short, specific text for the next prompt. At most 20 lines. */
      feedback: string;
    };

export interface Bundle {
  workspace: string;
  /** Absolute paths the candidate may edit. */
  allowedFiles: readonly string[];
}
