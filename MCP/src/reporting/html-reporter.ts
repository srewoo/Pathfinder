import type { TestResult } from '../storage/schemas.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function durationSeconds(ms: number | undefined): string {
  if (ms === undefined || ms === null) return '0.000';
  return (ms / 1000).toFixed(3);
}

function statusIcon(status: string): string {
  switch (status) {
    case 'passed':  return '✓';
    case 'failed':  return '✗';
    case 'error':   return '⚠';
    case 'skipped': return '–';
    default:        return '?';
  }
}

// ---------------------------------------------------------------------------
// SVG donut chart (radius 40, center 50,50, stroke-width 10)
// ---------------------------------------------------------------------------

function buildDonut(passed: number, failed: number, total: number): string {
  if (total === 0) {
    // Full grey ring when no results
    return `
<svg viewBox="0 0 100 100" width="120" height="120" aria-hidden="true">
  <circle cx="50" cy="50" r="40" fill="none" stroke="#6b7280" stroke-width="10"/>
  <text x="50" y="55" text-anchor="middle" font-size="16" font-weight="bold" fill="#e5e7eb">0%</text>
</svg>`.trim();
  }

  const R = 40;
  const CIRCUMFERENCE = 2 * Math.PI * R; // ≈ 251.327

  const passRatio   = passed / total;
  const failRatio   = failed / total;

  const passLen  = passRatio * CIRCUMFERENCE;
  const failLen  = failRatio * CIRCUMFERENCE;

  // Arc starts at the top; we rotate −90° via transform so 12-o'clock = 0°.
  // Layered circles with stroke-dasharray / stroke-dashoffset produce the arcs.

  const passOffset = CIRCUMFERENCE * (1 - passRatio);
  const failStart  = passRatio * CIRCUMFERENCE; // where fail arc begins (as offset)

  const pct = Math.round(passRatio * 100);

  // Background ring (dark grey track)
  const greyArc = `<circle cx="50" cy="50" r="${R}" fill="none" stroke="#374151" stroke-width="10"/>`;

  const failArc = failLen > 0.01
    ? `<circle cx="50" cy="50" r="${R}" fill="none" stroke="#ef4444" stroke-width="10"
         stroke-dasharray="${failLen.toFixed(3)} ${(CIRCUMFERENCE - failLen).toFixed(3)}"
         stroke-dashoffset="${(CIRCUMFERENCE - failStart).toFixed(3)}"
         transform="rotate(-90 50 50)"/>`
    : '';

  const passArc = passLen > 0.01
    ? `<circle cx="50" cy="50" r="${R}" fill="none" stroke="#22c55e" stroke-width="10"
         stroke-dasharray="${passLen.toFixed(3)} ${(CIRCUMFERENCE - passLen).toFixed(3)}"
         stroke-dashoffset="${passOffset.toFixed(3)}"
         transform="rotate(-90 50 50)"/>`
    : '';

  return `
<svg viewBox="0 0 100 100" width="120" height="120" aria-hidden="true">
  ${greyArc}
  ${failArc}
  ${passArc}
  <text x="50" y="55" text-anchor="middle" font-size="16" font-weight="bold" fill="#e5e7eb">${pct}%</text>
</svg>`.trim();
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#0f1117;color:#e5e7eb;font-family:system-ui,sans-serif;font-size:14px;line-height:1.6;padding:24px 16px}
a{color:#818cf8}
.container{max-width:960px;margin:0 auto}
header{margin-bottom:32px}
header h1{font-size:28px;font-weight:700;letter-spacing:-0.5px}
header .meta{margin-top:6px;color:#9ca3af;font-size:13px}
.summary{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;margin-bottom:32px}
.stat-box{background:#1a1d27;border:1px solid #2d3148;border-radius:10px;padding:14px 20px;min-width:110px;text-align:center;flex:1}
.stat-box .label{font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#9ca3af;margin-bottom:4px}
.stat-box .value{font-size:28px;font-weight:700;line-height:1}
.stat-box.passed .value{color:#22c55e}
.stat-box.failed .value{color:#ef4444}
.stat-box.error  .value{color:#f59e0b}
.stat-box.total  .value{color:#e5e7eb}
.stat-box.duration .value{font-size:20px;color:#818cf8}
.donut-box{background:#1a1d27;border:1px solid #2d3148;border-radius:10px;padding:14px 20px;display:flex;align-items:center;justify-content:center}
.results-section h2{font-size:18px;font-weight:600;margin-bottom:14px;color:#e5e7eb}
details{background:#1a1d27;border:1px solid #2d3148;border-radius:10px;margin-bottom:10px;overflow:hidden}
details.passed{border-left:4px solid #22c55e;background:#0f1f17}
details.failed{border-left:4px solid #ef4444;background:#1f0f0f}
details.error {border-left:4px solid #f59e0b;background:#1f1a0a}
details>summary{cursor:pointer;list-style:none;padding:12px 16px;display:flex;align-items:center;gap:10px;user-select:none}
details>summary::-webkit-details-marker{display:none}
details>summary .icon{font-size:16px;font-weight:700;width:20px;text-align:center;flex-shrink:0}
details>summary .icon.passed{color:#22c55e}
details>summary .icon.failed{color:#ef4444}
details>summary .icon.error {color:#f59e0b}
details>summary .title{flex:1;font-weight:500;font-size:14px}
details>summary .dur{font-size:12px;color:#9ca3af;white-space:nowrap}
details>summary .chevron{color:#6b7280;font-size:12px;transition:transform 0.15s;margin-left:6px}
details[open]>summary .chevron{transform:rotate(90deg)}
.detail-body{padding:14px 16px 16px;border-top:1px solid #2d3148}
.steps-list{list-style:none;display:flex;flex-direction:column;gap:4px;margin-bottom:12px}
.steps-list:empty{display:none}
.step-item{display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-radius:6px;font-size:13px}
.step-item.passed{background:rgba(34,197,94,0.07)}
.step-item.failed{background:rgba(239,68,68,0.1)}
.step-item.skipped{background:rgba(107,114,128,0.1)}
.step-item .step-icon{font-weight:700;width:16px;text-align:center;flex-shrink:0;margin-top:1px}
.step-item.passed .step-icon{color:#22c55e}
.step-item.failed .step-icon{color:#ef4444}
.step-item.skipped .step-icon{color:#6b7280}
.step-item .step-desc{flex:1;color:#d1d5db}
.error-box{background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);border-radius:6px;padding:10px 12px;color:#fca5a5;font-family:ui-monospace,monospace;font-size:12px;white-space:pre-wrap;word-break:break-all;margin-top:4px}
.healing-list{list-style:none;display:flex;flex-direction:column;gap:4px;margin-top:8px}
.healing-item{display:flex;align-items:flex-start;gap:8px;font-size:12px;color:#a78bfa;padding:4px 6px;background:rgba(167,139,250,0.07);border-radius:6px}
.screenshot-toggle{margin-top:10px}
.screenshot-toggle>summary{cursor:pointer;list-style:none;font-size:12px;color:#818cf8;padding:4px 0;user-select:none}
.screenshot-toggle>summary::-webkit-details-marker{display:none}
.screenshot-toggle img{margin-top:8px;max-width:100%;border-radius:6px;border:1px solid #2d3148;display:block}
@media(max-width:600px){.summary{flex-direction:column}.stat-box{min-width:unset}}
`.trim();

// ---------------------------------------------------------------------------
// Per-result card HTML
// ---------------------------------------------------------------------------

function buildResultCard(result: TestResult): string {
  const dur = durationSeconds(result.duration);
  const icon = statusIcon(result.status);
  const statusClass = result.status === 'error' ? 'error'
    : result.status === 'failed' ? 'failed'
    : result.status === 'passed' ? 'passed'
    : 'total';

  // Steps list
  const stepsHtml = result.steps.map((sr) => {
    const sc = sr.status === 'passed' ? 'passed' : sr.status === 'skipped' ? 'skipped' : 'failed';
    const si = statusIcon(sr.status);
    const desc = escapeHtml(sr.step.description);
    return `<li class="step-item ${sc}"><span class="step-icon">${si}</span><span class="step-desc">${desc}</span></li>`;
  }).join('\n');

  // Error box
  const errorHtml = result.errorMessage
    ? `<div class="error-box">${escapeHtml(result.errorMessage)}</div>`
    : '';

  // Healing attempts
  const healingHtml = result.healingAttempts.length > 0
    ? `<ul class="healing-list">${result.healingAttempts.map((h) => {
        const method = escapeHtml(h.method);
        const selector = h.healedSelector ? escapeHtml(h.healedSelector) : '—';
        return `<li class="healing-item">🔧 Healed via <strong>${method}</strong>: <code>${selector}</code></li>`;
      }).join('\n')}</ul>`
    : '';

  // Screenshot
  const screenshotHtml = result.screenshot
    ? `<details class="screenshot-toggle">
        <summary>📷 Show screenshot</summary>
        <img src="data:image/png;base64,${result.screenshot}" alt="Test screenshot" loading="lazy">
      </details>`
    : '';

  return `
<details class="${statusClass}">
  <summary>
    <span class="icon ${statusClass}">${icon}</span>
    <span class="title">${escapeHtml(result.testCaseTitle)}</span>
    <span class="dur">${dur}s</span>
    <span class="chevron">▶</span>
  </summary>
  <div class="detail-body">
    <ul class="steps-list">
      ${stepsHtml}
    </ul>
    ${errorHtml}
    ${healingHtml}
    ${screenshotHtml}
  </div>
</details>`.trim();
}

// ---------------------------------------------------------------------------
// Public: generateHtmlReport
// ---------------------------------------------------------------------------

export function generateHtmlReport(results: TestResult[]): string {
  const total    = results.length;
  const passed   = results.filter((r) => r.status === 'passed').length;
  const failed   = results.filter((r) => r.status === 'failed').length;
  const errored  = results.filter((r) => r.status === 'error').length;

  const totalDurationMs = results.reduce((sum, r) => sum + (r.duration ?? 0), 0);
  const totalDurSec = durationSeconds(totalDurationMs);

  const runId    = results[0]?.runId ?? '—';
  const generated = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  const donut = buildDonut(passed, failed + errored, total);

  const resultCards = results.map(buildResultCard).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>pathfinder Test Report</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🐛 pathfinder Test Report</h1>
      <div class="meta">Generated: ${generated} &nbsp;|&nbsp; Run ID: ${escapeHtml(runId)}</div>
    </header>

    <section class="summary" aria-label="Summary">
      <div class="stat-box passed">
        <div class="label">Passed</div>
        <div class="value">${passed}</div>
      </div>
      <div class="stat-box failed">
        <div class="label">Failed</div>
        <div class="value">${failed}</div>
      </div>
      <div class="stat-box error">
        <div class="label">Error</div>
        <div class="value">${errored}</div>
      </div>
      <div class="stat-box total">
        <div class="label">Total</div>
        <div class="value">${total}</div>
      </div>
      <div class="stat-box duration">
        <div class="label">Duration</div>
        <div class="value">${totalDurSec}s</div>
      </div>
      <div class="donut-box" title="Pass/fail ratio">
        ${donut}
      </div>
    </section>

    <section class="results-section" aria-label="Test results">
      <h2>Results</h2>
      ${resultCards || '<p style="color:#6b7280">No results to display.</p>'}
    </section>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Public: generateJUnitXml
// ---------------------------------------------------------------------------

export function generateJUnitXml(results: TestResult[]): string {
  const total   = results.length;
  const failures = results.filter((r) => r.status === 'failed').length;
  const errors   = results.filter((r) => r.status === 'error').length;
  const totalMs  = results.reduce((sum, r) => sum + (r.duration ?? 0), 0);
  const totalSec = (totalMs / 1000).toFixed(3);
  const timestamp = new Date().toISOString();

  const testCases = results.map((r) => {
    const timeSec = (( r.duration ?? 0) / 1000).toFixed(3);
    const name    = escapeXml(r.testCaseTitle);

    let inner = '';
    if (r.status === 'failed' && r.errorMessage) {
      const short = escapeXml(r.errorMessage.split('\n')[0] ?? r.errorMessage);
      const full  = escapeXml(r.errorMessage);
      inner = `\n      <failure message="${short}" type="AssertionError">${full}</failure>`;
    } else if (r.status === 'error' && r.errorMessage) {
      const short = escapeXml(r.errorMessage.split('\n')[0] ?? r.errorMessage);
      const full  = escapeXml(r.errorMessage);
      inner = `\n      <error message="${short}" type="Error">${full}</error>`;
    }

    return `    <testcase name="${name}" classname="pathfinder" time="${timeSec}">${inner}\n    </testcase>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="pathfinder" tests="${total}" failures="${failures}" errors="${errors}" time="${totalSec}">
  <testsuite name="pathfinder" tests="${total}" failures="${failures}" errors="${errors}" time="${totalSec}" timestamp="${timestamp}">
${testCases}
  </testsuite>
</testsuites>`;
}
