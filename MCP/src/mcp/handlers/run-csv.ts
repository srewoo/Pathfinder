import type { AppConfig } from '../../config/config.js';
import { createAIClient } from '../../core/ai/ai-client.js';
import { expandBatch } from '../../orchestrator/batch-expander.js';
import { runOneLiners } from '../../orchestrator/run-manager.js';
import { generateHtmlReport } from '../../reporting/html-reporter.js';
import { resetTokenUsage, formatTokenSummary } from '../../core/ai/token-tracker.js';
import { createLogger } from '../../utils/logger.js';
import { withErrorHandling } from './_error-wrapper.js';

const log = createLogger('run-csv');

/**
 * Parse CSV content into an array of test case one-liners.
 * Supports formats:
 *   - One test per line (plain text)
 *   - CSV with header: title,type,context,start_url
 *   - CSV with header: test_case (single column)
 */
function parseCsv(csvContent: string): Array<{
  title: string;
  type?: string;
  context?: string;
  startUrl?: string;
}> {
  const lines = csvContent.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  // Detect if first line is a header
  const firstLine = lines[0].toLowerCase();
  const hasHeader = firstLine.includes('title') || firstLine.includes('test_case') || firstLine.includes('test case');

  if (!hasHeader) {
    // Plain text — one test per line
    return lines.map((line) => ({ title: line }));
  }

  // Parse CSV header
  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase().trim());
  const titleIdx = header.findIndex((h) => h === 'title' || h === 'test_case' || h === 'test case' || h === 'test');
  if (titleIdx === -1) {
    // Fallback — treat as plain text
    return lines.slice(1).map((line) => ({ title: line }));
  }

  const typeIdx = header.findIndex((h) => h === 'type');
  const contextIdx = header.findIndex((h) => h === 'context' || h === 'shared_context');
  const urlIdx = header.findIndex((h) => h === 'start_url' || h === 'url' || h === 'target_url');

  return lines.slice(1).filter(Boolean).map((line) => {
    const cols = parseCsvLine(line);
    return {
      title: cols[titleIdx]?.trim() ?? '',
      type: typeIdx >= 0 ? cols[typeIdx]?.trim() : undefined,
      context: contextIdx >= 0 ? cols[contextIdx]?.trim() : undefined,
      startUrl: urlIdx >= 0 ? cols[urlIdx]?.trim() : undefined,
    };
  }).filter((tc) => tc.title.length > 0);
}

/** Simple CSV line parser handling quoted fields */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

export async function handleRunCsv(args: {
  csv_content: string;
  target_url: string;
  mode?: 'run' | 'expand';
  batch_size?: number;
  headless?: boolean;
  concurrency?: number;
  storage_state_path?: string;
}, config: AppConfig) {
  return withErrorHandling(async () => {
    resetTokenUsage();

    const testCases = parseCsv(args.csv_content);
    if (testCases.length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'No test cases found in CSV. Expected one test per line, or CSV with header: title,type,context,start_url' }],
        isError: true,
      };
    }

    log.info(`Parsed ${testCases.length} test cases from CSV`);

    const aiClient = createAIClient({
      provider: config.ai.provider,
      apiKey: config.ai.apiKey,
      model: config.ai.model,
      embeddingModel: config.ai.embeddingModel,
      useLocalEmbeddings: config.ai.useLocalEmbeddings,
    });

    const oneLiners = testCases.map((tc) => tc.title);

    if (args.mode === 'expand') {
      // Expand only — don't execute
      const expanded = await expandBatch(oneLiners, aiClient, args.batch_size ?? 3, args.target_url);
      const summary = expanded.map((tc) =>
        `## ${tc.title}\nType: ${tc.type}\nStart URL: ${tc.startUrl ?? 'auto'}\n${tc.steps?.map((s, i) => `${i + 1}. ${s}`).join('\n') ?? 'No steps'}`
      ).join('\n\n---\n\n');

      return {
        content: [{
          type: 'text' as const,
          text: `Expanded ${expanded.length} test cases from CSV:\n\n${summary}`,
        }],
      };
    }

    // Full run — expand + execute
    const run = await runOneLiners(oneLiners, aiClient, {
      targetUrl: args.target_url,
      headless: args.headless ?? config.browser.headless,
      concurrency: args.concurrency ?? config.browser.concurrency,
      batchSize: args.batch_size ?? config.execution.batchSize,
      storageStatePath: args.storage_state_path,
    });

    const htmlReport = generateHtmlReport(run.results);
    const tokenInfo = formatTokenSummary(config.ai.model);
    const summary = `CSV Run ${run.id}: ${run.summary.passed}/${run.summary.total} passed, ${run.summary.failed} failed, ${run.summary.error} errors (from ${testCases.length} CSV rows) | ${tokenInfo}`;

    return {
      content: [
        { type: 'text' as const, text: summary },
        { type: 'text' as const, text: `\n\nHTML Report:\n${htmlReport}` },
      ],
    };
  }, 'run_csv');
}
