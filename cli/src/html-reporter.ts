import type { TestResult, StepResult } from './types.js';

// ---------------------------------------------------------------------------
// HTML Report
// ---------------------------------------------------------------------------

export function generateHtmlReport(results: TestResult[]): string {
  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const errored = results.filter((r) => r.status === 'error').length;
  const total = results.length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;

  // SVG donut chart
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const passedArc = total > 0 ? (passed / total) * circumference : 0;
  const failedArc = total > 0 ? ((failed + errored) / total) * circumference : 0;

  const donutChart = `
    <svg viewBox="0 0 100 100" class="donut-chart" aria-label="Test results donut chart">
      <circle cx="50" cy="50" r="${radius}" fill="none" stroke="#1e293b" stroke-width="12"/>
      ${total === 0 ? `<circle cx="50" cy="50" r="${radius}" fill="none" stroke="#334155" stroke-width="12"/>` : ''}
      ${failed + errored > 0 ? `
      <circle cx="50" cy="50" r="${radius}" fill="none" stroke="#ef4444" stroke-width="12"
        stroke-dasharray="${failedArc} ${circumference}"
        stroke-dashoffset="${circumference * 0.25}"
        transform="rotate(-90 50 50)"/>
      ` : ''}
      ${passed > 0 ? `
      <circle cx="50" cy="50" r="${radius}" fill="none" stroke="#22c55e" stroke-width="12"
        stroke-dasharray="${passedArc} ${circumference}"
        stroke-dashoffset="${circumference * 0.25 + failedArc}"
        transform="rotate(-90 50 50)"/>
      ` : ''}
      <text x="50" y="46" text-anchor="middle" class="donut-pct">${passRate}%</text>
      <text x="50" y="58" text-anchor="middle" class="donut-label">pass rate</text>
    </svg>`;

  const testRows = results.map((r) => renderTestResult(r)).join('\n');

  const generatedAt = new Date().toISOString();
  const durationSec = (totalDuration / 1000).toFixed(1);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>pathfinder Test Report</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0f172a;
      --surface: #1e293b;
      --surface2: #243147;
      --border: #334155;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --success: #22c55e;
      --error: #ef4444;
      --warning: #f59e0b;
      --primary: #6366f1;
      --radius: 8px;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      padding: 32px 24px;
    }

    .container { max-width: 960px; margin: 0 auto; }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 32px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
    }
    .header-title { font-size: 22px; font-weight: 700; letter-spacing: -0.3px; }
    .header-meta { font-size: 12px; color: var(--text-muted); margin-top: 4px; }

    /* Summary grid */
    .summary {
      display: grid;
      grid-template-columns: auto 1fr 1fr 1fr 1fr;
      gap: 16px;
      align-items: center;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px 24px;
      margin-bottom: 28px;
    }
    .donut-chart { width: 88px; height: 88px; }
    .donut-pct { font-size: 14px; font-weight: 700; fill: var(--text); }
    .donut-label { font-size: 7px; fill: var(--text-muted); }

    .stat { text-align: center; }
    .stat-value { font-size: 28px; font-weight: 700; line-height: 1; }
    .stat-label { font-size: 11px; color: var(--text-muted); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-passed .stat-value { color: var(--success); }
    .stat-failed .stat-value { color: var(--error); }
    .stat-error .stat-value { color: var(--warning); }
    .stat-total .stat-value { color: var(--text); }

    /* Test list */
    .tests-header {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 10px;
    }

    .test-item {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin-bottom: 8px;
      overflow: hidden;
    }
    .test-item.passed { border-left: 3px solid var(--success); }
    .test-item.failed { border-left: 3px solid var(--error); }
    .test-item.error  { border-left: 3px solid var(--warning); }

    .test-summary {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 16px;
      cursor: pointer;
      user-select: none;
      list-style: none;
    }
    .test-summary::-webkit-details-marker { display: none; }

    .status-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      font-size: 10px;
      font-weight: 700;
      flex-shrink: 0;
    }
    .status-badge.passed { background: rgba(34,197,94,0.15); color: var(--success); }
    .status-badge.failed { background: rgba(239,68,68,0.15); color: var(--error); }
    .status-badge.error  { background: rgba(245,158,11,0.15); color: var(--warning); }

    .test-title { flex: 1; font-size: 13px; font-weight: 500; }
    .test-duration { font-size: 11px; color: var(--text-muted); flex-shrink: 0; }
    .chevron { font-size: 10px; color: var(--text-muted); flex-shrink: 0; }

    .test-detail { padding: 0 16px 14px; }

    .error-box {
      background: rgba(239,68,68,0.08);
      border: 1px solid rgba(239,68,68,0.25);
      border-radius: 6px;
      padding: 10px 12px;
      font-size: 12px;
      color: #fca5a5;
      margin-bottom: 12px;
      font-family: 'Menlo', 'Consolas', monospace;
      word-break: break-all;
    }

    .steps-list { list-style: none; }
    .step-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 4px 0;
      font-size: 12px;
      color: var(--text-muted);
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .step-row:last-child { border-bottom: none; }
    .step-status {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      flex-shrink: 0;
      margin-top: 1px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 8px;
      font-weight: 700;
    }
    .step-status.passed { background: rgba(34,197,94,0.15); color: var(--success); }
    .step-status.failed { background: rgba(239,68,68,0.15); color: var(--error); }
    .step-status.skipped { background: rgba(148,163,184,0.15); color: var(--text-muted); }
    .step-desc { flex: 1; }
    .step-error { font-size: 11px; color: #fca5a5; margin-top: 2px; }
    .step-dur { font-size: 10px; color: var(--text-muted); flex-shrink: 0; }

    footer {
      margin-top: 40px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
      font-size: 11px;
      color: var(--text-muted);
      text-align: center;
    }
  </style>
</head>
<body>
<div class="container">
  <div class="header">
    <div>
      <div class="header-title">pathfinder Test Report</div>
      <div class="header-meta">Generated ${generatedAt} &nbsp;·&nbsp; ${durationSec}s total</div>
    </div>
  </div>

  <div class="summary">
    ${donutChart}
    <div class="stat stat-passed">
      <div class="stat-value">${passed}</div>
      <div class="stat-label">Passed</div>
    </div>
    <div class="stat stat-failed">
      <div class="stat-value">${failed}</div>
      <div class="stat-label">Failed</div>
    </div>
    <div class="stat stat-error">
      <div class="stat-value">${errored}</div>
      <div class="stat-label">Error</div>
    </div>
    <div class="stat stat-total">
      <div class="stat-value">${total}</div>
      <div class="stat-label">Total</div>
    </div>
  </div>

  <div class="tests-header">Test Results (${total})</div>

  <div class="tests-list">
    ${testRows}
  </div>

  <footer>pathfinder &mdash; Autonomous AI Test Runner</footer>
</div>
</body>
</html>`;
}

function renderTestResult(result: TestResult): string {
  const statusIcon = result.status === 'passed' ? '✓' : result.status === 'failed' ? '✗' : '⚠';
  const durationSec = (result.duration / 1000).toFixed(2);

  const errorHtml =
    result.errorMessage
      ? `<div class="error-box">${escapeHtml(result.errorMessage)}</div>`
      : '';

  const stepsHtml = result.steps.length > 0
    ? `<ul class="steps-list">
        ${result.steps.map((s) => renderStepRow(s)).join('\n')}
       </ul>`
    : '<p style="font-size:12px;color:var(--text-muted);">No steps recorded.</p>';

  return `<details class="test-item ${result.status}">
  <summary class="test-summary">
    <span class="status-badge ${result.status}">${statusIcon}</span>
    <span class="test-title">${escapeHtml(result.testCaseTitle)}</span>
    <span class="test-duration">${durationSec}s</span>
    <span class="chevron">▶</span>
  </summary>
  <div class="test-detail">
    ${errorHtml}
    ${stepsHtml}
  </div>
</details>`;
}

function renderStepRow(sr: StepResult): string {
  const icon = sr.status === 'passed' ? '✓' : sr.status === 'failed' ? '✗' : '–';
  const durMs = sr.duration > 0 ? `${sr.duration}ms` : '';
  const errorHtml = sr.error
    ? `<div class="step-error">${escapeHtml(sr.error)}</div>`
    : '';

  return `<li class="step-row">
  <span class="step-status ${sr.status}">${icon}</span>
  <span class="step-desc">
    <span>${escapeHtml(sr.step.description)}</span>
    ${errorHtml}
  </span>
  <span class="step-dur">${durMs}</span>
</li>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// JUnit XML Report
// ---------------------------------------------------------------------------

export function generateJUnitXml(results: TestResult[]): string {
  const passed = results.filter((r) => r.status === 'passed').length;
  const failures = results.filter((r) => r.status === 'failed').length;
  const errors = results.filter((r) => r.status === 'error').length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
  const timestamp = new Date().toISOString();

  const testCases = results
    .map((r) => {
      const durationSec = (r.duration / 1000).toFixed(3);
      const className = 'pathfinder.' + sanitizeXmlName(r.testCaseTitle);

      if (r.status === 'passed') {
        return `    <testcase name="${xmlAttr(r.testCaseTitle)}" classname="${xmlAttr(className)}" time="${durationSec}"/>`;
      }

      const tag = r.status === 'error' ? 'error' : 'failure';
      const message = r.errorMessage ?? 'Test failed';

      const failedStep = r.steps.find((s) => s.status === 'failed');
      const body = failedStep
        ? `Step ${failedStep.step.order}: ${failedStep.step.description}\n${failedStep.error ?? ''}`
        : message;

      return `    <testcase name="${xmlAttr(r.testCaseTitle)}" classname="${xmlAttr(className)}" time="${durationSec}">
      <${tag} message="${xmlAttr(message)}">${xmlCdata(body)}</${tag}>
    </testcase>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="pathfinder" tests="${results.length}" failures="${failures}" errors="${errors}" time="${(totalDuration / 1000).toFixed(3)}" timestamp="${timestamp}">
  <testsuite name="pathfinder" tests="${results.length}" failures="${failures}" errors="${errors}" skipped="0" time="${(totalDuration / 1000).toFixed(3)}" timestamp="${timestamp}">
${testCases}
  </testsuite>
</testsuites>`;
}

function xmlAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlCdata(str: string): string {
  // Escape ]]> sequences inside CDATA
  return `<![CDATA[${str.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function sanitizeXmlName(str: string): string {
  return str.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}
