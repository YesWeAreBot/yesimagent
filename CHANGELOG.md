# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking Changes
- **core**: `agent.continue(reason?)` is now `continue(prompt?)` — triggering a turn and appending a message are separate: without a prompt the turn opens on stored history alone and no synthesized `Continue.` message is written; with one, the text is appended verbatim as the turn's opening user message
- **core**: `AgentQueue.wake(reason?)` is now `AgentQueue.continue(prompt?)`, the queue side of the same call
- **core**: `TurnResult.usage` (the last step's numbers) is replaced by `TurnResult.totalUsage` — the turn's sum across its steps; the `turn.done` event carries the same `totalUsage`, and per-step numbers stay on `turn.step`
- **core**: the unused `parentId` field is gone from `AgentEntry` and `CreateEntryOptions`

### Fixed
- **core**: state is restored from the latest persisted `state` entry on `init()`, falling back to `initialState`
- **core**: a turn that finishes without a stream drops its buffered events, so a `send`-driven agent no longer keeps every finished turn's events in memory
- **core**: `interrupt()` discards every queued turn — the pump no longer starts the next one mid-teardown — and each discarded turn is closed with `turn.aborted`
- **core**: a throwing `beforeToolCall` or `afterToolCall` still reports `tool.failed` before the error travels on
- **gateway**: a rejected `reconfigure()` leaves the previous providers, model catalog and groups in place
## [0.0.8] - 2026-10-14

### Added

- `agent.send()` and `agent.run()` accept an array of messages, opening a single turn with the whole batch in order
- **core**: `agent.continue(reason?)` opens a turn from a synthesized `Continue.` user message when idle; while a turn is active (or a wake is already pending) the reason merges into that one pending wake — joined with `"; "` into the same message — and the wake fires when the queue drains

## [0.0.7] - 2026-10-11

### Breaking Changes

- **core**: the `turn.done` event no longer carries `usage`; per-step numbers stay on `turn.step` and the final usage on `TurnResult`

### Added

- **gateway**: think levels on model references (`provider:modelId[:level]`). The level rides into every call as the AI SDK's portable `reasoning` option — in `languageModel()` and per group member, each level its own breaker entry. A declaration listing `thinking.efforts` fails construction on an unsupported level.
- **gateway**: decision models — a `typesafe-ai` dialect and `decisionModel()` on the gateway interface, with `decision` added to the model types

### Changed

- **gateway**: the modality exports are now `MODALITIES` and `Modality` (previously `MODEL_MODALITIES` and `ModelModality`)
- **core**: `ai` bumped to 7.0.137 and `@ai-sdk/provider-utils` to 5.0.58

## [0.0.6] - 2026-10-04

### Added

- **core**: publishes every model part of every step on the `"stream"` channel as it arrives, so a UI can render a step before its messages are stored.

## [0.0.5] - 2026-09-29

### Added

- **core**: a tool can declare which caller tools reach it (`experimental_toolCallers`), enabling tools reachable only from generated code.

### Changed

- **core**: joined and deferred messages are now persisted at step boundaries.

### Fixed

- **core**: a step's tool result is now kept next to its tool call in the message history.

## [0.0.4] - 2026-09-26

### Added

- **gateway**: fuller exports for the provider dialects (`anthropic`, `google`, `openai`, `openai-compatible`).
- Publishing script for automated releases.

## [0.0.3] - 2026-09-25

### Changed

- **core**: simplified the `CustomMessage` interface.

## [0.0.2] - 2026-09-23

### Fixed

- Root package resolves `@yesimagent/core` with a workspace wildcard dependency.

## [0.0.1] - 2026-09-23

Initial release.

### Added

- **core** (`@yesimagent/core`): a small agent runtime on the [AI SDK](https://ai-sdk.dev):
  - turns with queueing, a step loop (`streamText` under the hood), tool execution, and `maxSteps`;
  - busy-move semantics on `send`: `defer` / `join` / `reject`, plus `trigger: false`;
  - explicit step-level turn continuation (`onStepFinish` returning `{ continue: false }`);
  - step warnings from invalid tool calls, `ToolChoiceViolationError` enforcement;
  - append-only typed entries (`message` / `event` / `state`) with `createMemoryStorage` and `createJsonlStorage`;
  - agent state with `AgentCustomState` declare-merge and state-entry restore on init;
  - plugin hooks: `init` / `stop`, `extendInstructions` / `extendTools`, `onAppend` / `transformEntries` / `transformMessages`, `toModelMessages`, `prepareStep`, `beforeToolCall` / `afterToolCall`, `onTurnFinish`;
  - `runtimeContext` per turn and `toolsContext` per tool;
  - usage and finish-reason reporting on the last step.
- **core**: typed `agent.channel` pub-sub with an `"agent"` lifecycle channel carrying turn events (`turn.queued`, `turn.start`, `turn.step`, `turn.done`, `turn.failed`, `turn.aborted`) and tool events (`tool.start`, `tool.done`, `tool.failed`, `tool.blocked`).
- **core**: message helpers `createUserMessage`, `createSystemMessage`, `createAssistantMessage`, `createToolMessage`, `createCustomMessage`.
- **gateway** (`@yesimagent/gateway`): an AI SDK model registry that resolves `provider:model` references to native AI SDK models, with:
  - failover / round-robin / random model groups with circuit breakers;
  - four built-in wire apis: `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`;
  - `${VAR}` expansion for `apiKey` / `headers` against the gateway's `env`;
  - construction-time validation (`GatewayError`) and custom `apis` registration.
- **docs**: READMEs for both packages.
- **build**: release workflow and bump configuration for automated versioning.

[Unreleased]: https://github.com/YesWeAreBot/yesimagent/compare/v0.0.8...HEAD
[0.0.8]: https://github.com/YesWeAreBot/yesimagent/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/YesWeAreBot/yesimagent/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/YesWeAreBot/yesimagent/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/YesWeAreBot/yesimagent/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/YesWeAreBot/yesimagent/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/YesWeAreBot/yesimagent/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/YesWeAreBot/yesimagent/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/YesWeAreBot/yesimagent/compare/8f31108...v0.0.1
