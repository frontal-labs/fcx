/** Thrown when `createAcpAgent` is given an invalid configuration. */
export class AcpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpConfigError";
  }
}
