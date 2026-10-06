# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **gateway**: think levels on model references (`provider:modelId[:level]`). The level rides into every call as the AI SDK's portable `reasoning` option — in `languageModel()` and per group member, each level its own breaker entry. A declaration listing `thinking.efforts` fails construction on an unsupported level.

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

[Unreleased]: https://github.com/YesWeAreBot/yesimagent/compare/v0.0.6...HEAD
[0.0.6]: https://github.com/YesWeAreBot/yesimagent/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/YesWeAreBot/yesimagent/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/YesWeAreBot/yesimagent/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/YesWeAreBot/yesimagent/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/YesWeAreBot/yesimagent/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/YesWeAreBot/yesimagent/compare/8f31108...v0.0.1
