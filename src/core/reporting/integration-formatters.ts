/**
 * Format test run results for external systems beyond raw webhooks:
 *   • Slack — Block Kit message body
 *   • Linear — issue title + markdown description
 *   • Jira — issue summary + ADF-compatible description
 *
 * The formatters are pure: they return the JSON body the caller posts.
 */

import type { TestResult, TestRun } from '../../storage/schemas';

export interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  fields?: Array<{ type: string; text: string }>;
}

export interface SlackMessage {
  text: string;
  blocks: SlackBlock[];
}

export function formatSlackForSuite(run: TestRun): SlackMessage {
  const summary = run.summary;
  const passRate = summary.total === 0 ? 0 : (summary.passed / summary.total) * 100;
  const emoji = summary.failed > 0 || summary.error > 0 ? ':x:' : ':white_check_mark:';
  const headline = `${emoji} Pathfinder: ${summary.passed}/${summary.total} passed (${passRate.toFixed(0)}%)`;

  return {
    text: headline,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${headline}*` },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Passed:*\n${summary.passed}` },
          { type: 'mrkdwn', text: `*Failed:*\n${summary.failed}` },
          { type: 'mrkdwn', text: `*Errors:*\n${summary.error}` },
          { type: 'mrkdwn', text: `*Healed:*\n${summary.healed ?? 0}` },
        ],
      },
      ...failingTestsBlocks(run.results),
    ],
  };
}

function failingTestsBlocks(results: TestResult[]): SlackBlock[] {
  const failing = results.filter((r) => r.status !== 'passed');
  if (failing.length === 0) return [];
  const lines = failing.slice(0, 10).map((r) => {
    const err = r.errorMessage ? ` — ${truncate(r.errorMessage, 100)}` : '';
    return `• ${escapeMd(r.testCaseTitle)}${err}`;
  });
  if (failing.length > 10) lines.push(`…and ${failing.length - 10} more`);
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Failing tests:*\n${lines.join('\n')}` },
    },
  ];
}

// ─── Linear ──────────────────────────────────────────────────────────────

export interface LinearIssue {
  title: string;
  description: string;
  /** Suggested label IDs — Linear caller can map to real labels. */
  labels: string[];
}

export function formatLinearForFailure(result: TestResult, runId: string): LinearIssue {
  const description = [
    `## Pathfinder detected a test failure`,
    ``,
    `**Test:** ${escapeMd(result.testCaseTitle)}`,
    `**Run:** \`${runId}\``,
    `**Status:** ${result.status}`,
    `**Started:** ${result.startedAt}`,
    `**Duration:** ${result.duration ?? 0}ms`,
    ``,
    `### Error`,
    '```',
    result.errorMessage ?? '(no error message captured)',
    '```',
    ``,
    `### Steps (${result.steps.length})`,
    ...result.steps.map(
      (s) => `${s.status === 'passed' ? '✅' : '❌'} \`${s.step.action}\` ${escapeMd(s.step.description)}`,
    ),
  ];

  if ((result.healingAttempts?.length ?? 0) > 0) {
    description.push('', `### Healing attempts (${result.healingAttempts.length})`);
    for (const ha of result.healingAttempts) {
      description.push(
        `- ${ha.success ? '✅' : '❌'} \`${ha.method}\` — ${ha.originalSelector}` +
          (ha.healedSelector ? ` → ${ha.healedSelector}` : ''),
      );
    }
  }

  return {
    title: `[pathfinder] ${truncate(result.testCaseTitle, 80)}`,
    description: description.join('\n'),
    labels: ['pathfinder', 'qa', result.status],
  };
}

// ─── Jira ────────────────────────────────────────────────────────────────

export interface JiraIssue {
  summary: string;
  description: string;
  labels: string[];
  priority: 'High' | 'Medium' | 'Low';
}

export function formatJiraForFailure(result: TestResult, runId: string): JiraIssue {
  const linear = formatLinearForFailure(result, runId);
  // Jira uses similar markdown via wiki-style; reuse linear description.
  return {
    summary: linear.title,
    description: linear.description,
    labels: linear.labels,
    priority: result.status === 'error' ? 'High' : 'Medium',
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function escapeMd(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\*/g, '\\*');
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
