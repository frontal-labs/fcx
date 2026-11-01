export interface ModelHost {
  countTokens(text: string): number;
  shutdown(): Promise<void>;
  generate?(prompt: string): Promise<any>;
}
export function createMockModelHost(): ModelHost {
  return {
    countTokens: (t) => Math.ceil(t.length / 3.5),
    shutdown: async () => {},
    generate: async () => ({})
  };
}
export class ModelWorker {
  constructor() {}
  async start() {}
  async shutdown() {}
}
