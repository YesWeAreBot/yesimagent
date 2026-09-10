export interface AgentCustomState {}

export interface AgentState extends AgentCustomState {
  version: number;
}

export interface CreateStateManagerOptions {
  initialState: AgentState;
  onChange?: (state: Readonly<AgentState>) => Promise<void> | void;
}

export class AgentStateManager {
  private state: AgentState;
  private pending: Promise<void> | undefined;

  constructor(private readonly options: CreateStateManagerOptions) {
    this.state = structuredClone(options.initialState);
  }

  get(): Readonly<AgentState> {
    return this.state;
  }

  restore(next: AgentState): void {
    this.state = structuredClone(next);
  }

  set(next: AgentState | ((previous: Readonly<AgentState>) => AgentState)): Promise<void> {
    return this.commit((previous) => (typeof next === "function" ? next(previous) : next));
  }

  update(next: Partial<AgentState>): Promise<void> {
    return this.commit((previous) => ({ ...previous, ...next }));
  }

  private commit(resolve: (previous: Readonly<AgentState>) => AgentState): Promise<void> {
    const apply = async () => {
      const next = structuredClone(resolve(this.state));
      await this.options.onChange?.(next);
      this.state = next;
    };

    const operation = this.pending === undefined ? apply() : this.pending.then(apply);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.pending = tail;
    void operation.then(
      () => {
        if (this.pending === tail) this.pending = undefined;
      },
      () => {
        if (this.pending === tail) this.pending = undefined;
      },
    );
    return operation;
  }
}
