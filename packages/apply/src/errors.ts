import type { EditErrorCode } from "./types.js";

export class EditError extends Error {
  readonly code: EditErrorCode;
  constructor(code: EditErrorCode, message: string) {
    super(message);
    this.name = "EditError";
    this.code = code;
  }
}

export class StaleFileError extends Error {
  readonly file: string;
  constructor(file: string) {
    super(`${file} changed after it was read; nothing was written. Run the command again.`);
    this.name = "StaleFileError";
    this.file = file;
  }
}
