export class FcError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  constructor(message: string, code = "UNKNOWN", hint?: string) {
    super(message);
    this.name = "FcError";
    this.code = code;
    this.hint = hint;
  }
}

export class ConfigError extends FcError {
  constructor(message: string, hint?: string) {
    super(message, "CONFIG_ERROR", hint);
    this.name = "ConfigError";
  }
}
