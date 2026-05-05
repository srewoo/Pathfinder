# ADR-002: Fully Client-Side Architecture (BYOK)

**Status**: Accepted
**Date**: 2026-03-01

## Context

pathfinder needs to call AI APIs for embeddings, test generation, and test planning. This could be done via a hosted backend proxy or directly from the browser. The choice affects user privacy, deployment complexity, operational cost, and business model.

## Decision

**Fully client-side execution** with **Bring Your Own Key (BYOK)**. All AI API calls are made directly from the browser using the user's own API key. No backend infrastructure is operated.

## Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Client-side BYOK** | Zero infra cost, user controls their data and key, no privacy risk | User must obtain and manage their own API key |
| Backend proxy | Hide API key, rate-limit abuse, add shared features | Operational cost, privacy concerns, vendor dependency for every user |
| Local LLM only | Complete privacy, no API cost | Large model files, slow inference, poor quality vs cloud APIs |
| Hybrid (proxy + local) | Flexibility | Highest complexity, two systems to maintain |

## Consequences

- **Privacy**: User data (DOM snapshots, test descriptions) never leaves the browser to a pathfinder-controlled server. It goes directly to the user's chosen AI provider.
- **Cost**: Zero hosting costs for pathfinder. Users pay their AI provider directly at consumption rates.
- **Security**: API key stored in `chrome.storage.local` (encrypted by the OS keychain on most platforms). Key is never transmitted to any pathfinder endpoint.
- **Limitation**: No shared knowledge bases, no team collaboration features, no usage analytics. These would require a backend.
- **API key exposure risk**: If the user's Chrome profile is compromised, the API key could be extracted. Documented clearly in the README.
