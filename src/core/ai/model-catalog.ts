/**
 * Provider model catalogue — "what can this key actually call?"
 *
 * The model field used to be free text, so a typo or a model the key has no
 * access to only surfaced as a 404 in the middle of a crawl. Listing the models
 * doubles as the key test: a provider that returns its catalogue has accepted
 * the credential, and the returned ids are exactly the ones that key is
 * entitled to — no hardcoded list can know that.
 *
 * ADR-002 holds: the key goes to the provider the user chose and nowhere else.
 * `fetch` is injected so every branch is testable without a network or a key.
 */
import type { AIProvider } from '../../storage/schemas';

export interface ModelOption {
  id: string;
  /** Human label where the provider gives one (Anthropic), else the id. */
  label: string;
  kind: 'chat' | 'embedding';
  /** Epoch seconds, when the provider reports it. Used for newest-first order. */
  created?: number;
}

export type CatalogResult =
  | { ok: true; models: ModelOption[] }
  | { ok: false; error: string };

const TIMEOUT_MS = 20_000;

/**
 * Model families the chat path cannot drive.
 *
 * Audio, image and moderation endpoints are separate APIs; a legacy completions
 * model returns a 400 from /chat/completions. Offering any of them in the Model
 * dropdown would let a user pick something guaranteed to fail at run time.
 */
const NON_CHAT = [
  'whisper',
  'tts',
  'dall-e',
  'sora',
  'moderation',
  'audio',
  'image',
  'transcribe',
  'realtime',
  'davinci',
  'babbage',
  'search',
  'similarity',
  'edit',
];

function isEmbedding(id: string): boolean {
  return id.includes('embedding') || id.includes('embed');
}

function classifyOpenAI(id: string): ModelOption['kind'] | undefined {
  const lower = id.toLowerCase();
  if (isEmbedding(lower)) return 'embedding';
  if (NON_CHAT.some((deny) => lower.includes(deny))) return undefined;
  return 'chat';
}

/** Newest first where the provider dates its models, then alphabetical. */
function order(models: ModelOption[]): ModelOption[] {
  return [...models].sort((a, b) => {
    if (a.created && b.created && a.created !== b.created) return b.created - a.created;
    if (a.created && !b.created) return -1;
    if (!a.created && b.created) return 1;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Turn a transport failure into a message naming what to fix.
 *
 * "401" sends the user to a search engine; "the key was rejected" sends them to
 * the key field.
 */
async function failure(response: Response, provider: AIProvider): Promise<string> {
  if (response.status === 401 || response.status === 403) {
    return `${label(provider)} rejected this API key (${response.status}). Check the key and that it is active.`;
  }
  if (response.status === 429) {
    return `${label(provider)} rate-limited the request (429). Wait a moment and test again.`;
  }
  const body = await response.text().catch(() => '');
  return `${label(provider)} returned ${response.status}: ${body.slice(0, 200)}`;
}

function label(provider: AIProvider): string {
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'anthropic') return 'Anthropic';
  return 'Google AI';
}

interface OpenAIModel {
  id?: string;
  created?: number;
}

interface AnthropicModel {
  id?: string;
  display_name?: string;
  created_at?: string;
}

interface GoogleModel {
  name?: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
}

function parseOpenAI(payload: unknown): ModelOption[] {
  const data = (payload as { data?: OpenAIModel[] })?.data;
  if (!Array.isArray(data)) return [];
  const out: ModelOption[] = [];
  for (const raw of data) {
    if (!raw?.id) continue;
    const kind = classifyOpenAI(raw.id);
    if (!kind) continue;
    out.push({ id: raw.id, label: raw.id, kind, created: raw.created });
  }
  return out;
}

function parseAnthropic(payload: unknown): ModelOption[] {
  const data = (payload as { data?: AnthropicModel[] })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .filter((raw): raw is AnthropicModel & { id: string } => Boolean(raw?.id))
    .map((raw) => ({
      id: raw.id,
      label: raw.display_name ?? raw.id,
      // Anthropic has no embedding API, so everything listed is a chat model.
      kind: 'chat' as const,
      created: raw.created_at ? Math.floor(Date.parse(raw.created_at) / 1000) || undefined : undefined,
    }));
}

function parseGoogle(payload: unknown): ModelOption[] {
  const models = (payload as { models?: GoogleModel[] })?.models;
  if (!Array.isArray(models)) return [];
  const out: ModelOption[] = [];
  for (const raw of models) {
    if (!raw?.name) continue;
    // Google qualifies ids as "models/gemini-3-pro"; the API takes either, but
    // the bare id is what the rest of Pathfinder stores.
    const id = raw.name.replace(/^models\//, '');
    const methods = raw.supportedGenerationMethods ?? [];
    // The declared methods are authoritative — far better than guessing from
    // the name, which is how an embedding model ends up selected for chat.
    if (methods.includes('generateContent')) {
      out.push({ id, label: raw.displayName ?? id, kind: 'chat' });
    } else if (methods.includes('embedContent')) {
      out.push({ id, label: raw.displayName ?? id, kind: 'embedding' });
    }
  }
  return out;
}

interface Endpoint {
  url: string;
  headers: Record<string, string>;
  parse: (payload: unknown) => ModelOption[];
}

function endpointFor(provider: AIProvider, apiKey: string): Endpoint {
  switch (provider) {
    case 'openai':
      return {
        url: 'https://api.openai.com/v1/models',
        headers: { Authorization: `Bearer ${apiKey}` },
        parse: parseOpenAI,
      };
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/models?limit=100',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          // Required for any non-server origin, which includes an extension.
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        parse: parseAnthropic,
      };
    case 'google':
      return {
        // Key in a header, not the query string: a URL carrying the key ends up
        // in error text and network logs.
        url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
        headers: { 'x-goog-api-key': apiKey },
        parse: parseGoogle,
      };
    default:
      throw new Error(`Unsupported AI provider: ${String(provider)}`);
  }
}

/**
 * List the models this key can call.
 *
 * Never throws: every failure comes back as `{ ok: false, error }` so the
 * settings panel can render the reason next to the field that caused it.
 */
export async function listModels(
  provider: AIProvider,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<CatalogResult> {
  if (!apiKey.trim()) {
    return { ok: false, error: 'Enter an API key first.' };
  }

  let endpoint: Endpoint;
  try {
    endpoint = endpointFor(provider, apiKey.trim());
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  let response: Response;
  try {
    response = await fetchImpl(endpoint.url, {
      method: 'GET',
      headers: endpoint.headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      error: `Could not reach ${label(provider)}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!response.ok) {
    return { ok: false, error: await failure(response, provider) };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: `${label(provider)} returned a response that was not JSON.` };
  }

  const models = order(endpoint.parse(payload));
  if (models.length === 0) {
    // A valid key with an empty catalogue is a real state (a restricted project
    // key), and it must not look like a success that silently offers nothing.
    return {
      ok: false,
      error: `${label(provider)} accepted the key but returned no usable models for it.`,
    };
  }
  return { ok: true, models };
}

export function chatModels(models: readonly ModelOption[]): ModelOption[] {
  return models.filter((m) => m.kind === 'chat');
}

export function embeddingModels(models: readonly ModelOption[]): ModelOption[] {
  return models.filter((m) => m.kind === 'embedding');
}
