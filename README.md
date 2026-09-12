# yesimagent

TypeScript packages for building agents on the [AI SDK](https://ai-sdk.dev): a runtime kernel, and an AI SDK model registry.

> Work in progress. The packages are versioned `0.0.1` and the interfaces may still change.

## Packages

| Package                                       | Description                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [`@yesimagent/core`](packages/core)           | Agent runtime: turns, channels, entries, state, storage, tools. Re-exports the AI SDK so hosts depend on one package.                |
| [`@yesimagent/gateway`](packages-ext/gateway) | AI SDK model registry: resolve `provider:model` references to native models, with failover groups and circuit breakers. Cordis-free. |
| [`yesimagent`](packages/yesimagent)           | Umbrella package re-exporting `@yesimagent/core`.                                                                                    |

## License

[MIT](LICENSE)
