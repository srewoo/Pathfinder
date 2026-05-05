import { testResultRepo } from '../../storage/repositories/test-result-repo.js';
import { generateHtmlReport } from '../../reporting/html-reporter.js';
import { withErrorHandling } from './_error-wrapper.js';

export async function handleGetResults(args: { run_id: string }) {
  return withErrorHandling(async () => {
    const results = await testResultRepo.getByRunId(args.run_id);
    if (results.length === 0) {
      return { content: [{ type: 'text' as const, text: `No results found for run ${args.run_id}` }] };
    }
    const html = generateHtmlReport(results);
    const passed = results.filter((r) => r.status === 'passed').length;
    return {
      content: [
        { type: 'text' as const, text: `Run ${args.run_id}: ${passed}/${results.length} passed` },
        { type: 'text' as const, text: html },
      ],
    };
  }, 'get_results');
}
