/** A missing or unusable part of the configuration that the gateway nevertheless built around. */
export class GatewayError extends Error {
  declare readonly cause?: unknown;

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "GatewayError";
  }
}
