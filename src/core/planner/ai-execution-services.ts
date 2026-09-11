/**
 * AI-backed execution services (fix.md §6).
 *
 * The implementations the executor declares as ports. Deliberately located
 * OUTSIDE `core/executor/**`: planning and healing legitimately need a model, and
 * putting them here is what lets the executor keep a hard zero-AI boundary
 * without pretending the capability does not exist.
 *
 * The dependency now points the right way. Previously: executor → AI. Now:
 * caller → (AI services, executor), with the executor depending only on types.
 */
import type { AIClientInterface } from '../ai/ai-client';
import type {
  AssertionSuggester,
  ExecutionServices,
  PlanProvider,
  StepHealer,
} from '../executor/execution-ports';
import { planTest } from './test-planner';
import { healStep } from '../healing/self-healer';
import { generatePostStepAssertion, assertionToStep } from './assertion-generator';
import { createLogger } from '../../utils/logger';

const log = createLogger('ai-execution-services');

export interface AiServiceOptions {
  /**
   * Allow the AI tier of self-healing. Default true, preserving existing
   * behaviour — but a caller that needs a reproducible run can turn it off, and
   * the deterministic tiers still apply.
   */
  aiHealing?: boolean;
  /** Generate assertions from live DOM after key steps. Default false. */
  aiAssertions?: boolean;
}

/**
 * Build execution services from an AI client.
 *
 * One instance serves a whole suite: the test case arrives through the port on
 * each call, so nothing is captured per test.
 */
export function createAiExecutionServices(
  aiClient: AIClientInterface,
  opts: AiServiceOptions = {}
): ExecutionServices {
  const plan: PlanProvider = (testCase, request) =>
    planTest(
      testCase,
      aiClient,
      request.tabId,
      request.forceFresh,
      request.accessibilityContext
        ? { accessibilityContext: request.accessibilityContext }
        : undefined,
      request.planningMode
    );

  const heal: StepHealer | undefined =
    opts.aiHealing === false
      ? undefined
      : (step, error, tabId, runner, context) =>
          healStep(step, error, tabId, aiClient, runner, context);

  const suggestAssertion: AssertionSuggester | undefined = opts.aiAssertions
    ? async (tabId, step, previousUrl) => {
        try {
          const generated = await generatePostStepAssertion(tabId, step, previousUrl, aiClient);
          // The order is rewritten by the executor when it splices the step in.
          return generated ? assertionToStep(generated, step.order) : null;
        } catch (err) {
          // An assertion we could not generate is not a test failure — the step
          // itself already succeeded. Degrade quietly but audibly.
          log.debug('Post-step assertion generation failed', err);
          return null;
        }
      }
    : undefined;

  return { plan, heal, suggestAssertion };
}
