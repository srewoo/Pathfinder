# ADR-004: Multi-Provider AI Abstraction Layer

**Status**: Accepted
**Date**: 2026-03-01

## Context

The market for LLM APIs is rapidly evolving. Locking pathfinder to a single AI provider would limit the user base (users may already have keys for specific providers) and create a single point of commercial risk. Different providers have different strengths: OpenAI for best-in-class function calling, Anthropic for long context reasoning, Google for multimodal tasks and competitive pricing.

## Decision

Define a single `AIClientInterface` with `chat()` and `embed()` methods. Implement one concrete adapter per provider (OpenAI, Anthropic, Google). A factory function (`createAIClient`) instantiates the correct adapter based on user settings.

```typescript
interface AIClientInterface {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  embed(texts: string[]): Promise<number[][]>;
}
```

## Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Abstract interface + adapters** | Provider-agnostic core logic, easy to add providers, testable with stubs | Slight indirection overhead |
| Use LangChain.js | Many providers out of the box | Large bundle (~800 KB+), not extension-friendly, over-engineered for this scope |
| OpenAI-only | Simplest | Excludes Anthropic/Google users, single provider risk |
| Raw fetch to each API | No abstraction overhead | Duplicated retry/error logic, hard to test |

## Consequences

- **Embedding caveat**: Anthropic does not provide a native embedding API. Users who select Anthropic as their provider must use a secondary embedding provider, or accept that RAG context retrieval will not function. This is documented in the Settings UI.
- **Model selection**: Each provider has different model naming conventions. The settings panel exposes free-text model name inputs with sensible defaults per provider.
- **Testing**: All core logic is tested against the `AIClientInterface` stub — no real API calls in unit or integration tests.
- **Adding providers**: A new provider requires only a new file implementing `AIClientInterface` and registering it in `createAIClient`. No core logic changes.
