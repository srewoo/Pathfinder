import type { Flow } from '../../storage/schemas';
import { flowDB } from '../../storage/indexed-db';
import { generateId } from '../../utils/hash';

export async function saveFlow(flow: Omit<Flow, 'flowId' | 'createdAt' | 'updatedAt'>): Promise<Flow> {
  const now = new Date().toISOString();
  const saved: Flow = {
    ...flow,
    flowId: generateId(),
    createdAt: now,
    updatedAt: now,
  };
  await flowDB.put(saved);
  return saved;
}

export async function updateFlow(flowId: string, patch: Partial<Flow>): Promise<Flow | undefined> {
  const existing = await flowDB.get(flowId);
  if (!existing) return undefined;

  const updated: Flow = {
    ...existing,
    ...patch,
    flowId,
    updatedAt: new Date().toISOString(),
  };
  await flowDB.put(updated);
  return updated;
}

export async function deleteFlow(flowId: string): Promise<void> {
  await flowDB.delete(flowId);
}

export async function getAllFlows(): Promise<Flow[]> {
  const flows = await flowDB.getAll();
  return flows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getFlow(flowId: string): Promise<Flow | undefined> {
  return flowDB.get(flowId);
}

export function serializeFlowForAI(flow: Flow): string {
  const lines: string[] = [`## Flow: ${flow.name}`, `Description: ${flow.description}`];

  if (flow.startUrl) {
    lines.push(`Start URL: ${flow.startUrl}`);
    if (flow.startUrlInference) {
      lines.push(
        `Start URL inference: ${flow.startUrlInference.method} (${flow.startUrlInference.confidence}, score=${flow.startUrlInference.score})`
      );
      lines.push(`Start URL reason: ${flow.startUrlInference.reason}`);
    }
  }

  lines.push('', 'Steps:');

  flow.steps.forEach((step) => {
    const target = step.target ? ` → ${step.target}` : '';
    const value = step.value ? ` [value: "${step.value}"]` : '';
    const selector = step.selector ? ` (selector: ${step.selector})` : '';
    const outcome = step.expectedOutcome ? ` [expects: ${step.expectedOutcome}]` : '';
    lines.push(`  ${step.order}. ${step.action}${target}${value}${selector}: ${step.description}${outcome}`);
  });

  return lines.join('\n');
}

export function serializeFlowsForAI(flows: Flow[]): string {
  if (flows.length === 0) {
    return 'No learned flows available.';
  }

  return flows.map((flow) => serializeFlowForAI(flow)).join('\n\n');
}
