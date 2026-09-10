export class AgentRuntimeError extends Error {
  declare readonly cause?: unknown;

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "AgentRuntimeError";
  }
}

export class AgentBusyError extends AgentRuntimeError {
  constructor() {
    super("Agent is busy");
    this.name = "AgentBusyError";
  }
}

export class ToolConflictError extends AgentRuntimeError {
  constructor(toolName: string) {
    super(`Tool conflict: ${toolName}`);
    this.name = "ToolConflictError";
  }
}

export function formatErrorCause(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
