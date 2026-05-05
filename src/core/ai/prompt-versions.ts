/**
 * Prompt-version registry.
 *
 * Every named prompt in `prompt-templates.ts` should have a version recorded
 * here. When you change a prompt, bump its version. The runner can then log
 * `prompt=<name>@<version>` against each request so prompt-A/B comparisons,
 * regression hunts, and "which version generated this output" lookups work.
 *
 * Versioning convention:
 *   1.x.0 — wording or formatting tweaks
 *   x.0.0 — semantic change to the task or output schema
 */

export const PROMPT_VERSIONS: Record<string, string> = {
  selectorHealing: '1.2.0',
  interactivePlanning: '1.3.0',
  testPlanning: '1.4.0',
  testExpansion: '1.1.0',
  flowExtraction: '1.0.0',
  pageExploration: '1.0.0',
  documentChunking: '1.0.0',
  imageDescription: '1.0.0',
  assertionGeneration: '1.0.0',
};

export function getPromptVersion(name: string): string {
  return PROMPT_VERSIONS[name] ?? '0.0.0';
}

export function tagPromptVersion(name: string, raw: string): string {
  // Embed an HTML comment in the system prompt so it surfaces in any
  // request log without changing the model's behavior.
  const ver = getPromptVersion(name);
  return `<!-- pathfinder-prompt: ${name}@${ver} -->\n${raw}`;
}
