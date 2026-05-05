import React, { useEffect, useState } from 'react';
import { TrendingUp, TrendingDown, AlertTriangle, Clock, Activity, Minus } from 'lucide-react';
import { sendToBackground } from '../../../messaging/messenger';
import type { TestTrends } from '../../../utils/report-exporter';

export function TestDashboard() {
  const [trends, setTrends] = useState<TestTrends | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadTrends();
  }, []);

  const loadTrends = async () => {
    setLoading(true);
    try {
      const resp = await sendToBackground<{ success: boolean; trends?: TestTrends }>({
        type: 'GET_TEST_TRENDS',
      });
      if (resp?.success && resp.trends) {
        setTrends(resp.trends);
      }
    } catch { /* ignore */ }
    setLoading(false);
  };

  if (loading) {
    return (
      <div className="p-3 text-2xs text-text-muted text-center">Loading trends...</div>
    );
  }

  if (!trends || trends.overall.totalRuns === 0) {
    return (
      <div className="p-3 text-2xs text-text-muted text-center">
        Run tests multiple times to see trends and flaky test detection.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Overall Stats */}
      <div className="grid grid-cols-3 gap-2">
        <StatCard
          label="Avg Pass Rate"
          value={`${trends.overall.avgPassRate}%`}
          color={trends.overall.avgPassRate >= 80 ? 'text-success' : trends.overall.avgPassRate >= 50 ? 'text-warning' : 'text-error'}
        />
        <StatCard
          label="Avg Duration"
          value={formatDuration(trends.overall.avgDuration)}
          color="text-info"
        />
        <StatCard
          label="Total Runs"
          value={String(trends.overall.totalRuns)}
          color="text-text-secondary"
        />
      </div>

      {/* Pass Rate Trend (sparkline) */}
      {trends.passRateHistory.length > 1 && (
        <div className="bg-surface-2 border border-border rounded-lg p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Activity size={11} className="text-primary" />
            <span className="text-xs font-medium text-text-primary">Pass Rate Trend</span>
          </div>
          <PassRateChart data={trends.passRateHistory} />
        </div>
      )}

      {/* Flaky Tests */}
      {trends.flakyTests.length > 0 && (
        <div className="bg-surface-2 border border-border rounded-lg p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <AlertTriangle size={11} className="text-warning" />
            <span className="text-xs font-medium text-text-primary">
              Flaky Tests ({trends.flakyTests.length})
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            {trends.flakyTests.slice(0, 5).map((t) => (
              <div key={t.testCaseId} className="flex items-center justify-between text-2xs">
                <span className="text-text-secondary truncate flex-1 mr-2">{t.title}</span>
                <span className="flex items-center gap-1 text-text-muted whitespace-nowrap">
                  <span className="text-success">{t.passCount}P</span>
                  <span>/</span>
                  <span className="text-error">{t.failCount}F</span>
                  <span className="text-warning ml-1">({Math.round(t.flakyScore * 100)}%)</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Duration Trends */}
      {trends.avgDurations.length > 0 && (
        <div className="bg-surface-2 border border-border rounded-lg p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Clock size={11} className="text-info" />
            <span className="text-xs font-medium text-text-primary">Duration Trends</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {trends.avgDurations.slice(0, 5).map((t) => (
              <div key={t.testCaseId} className="flex items-center justify-between text-2xs">
                <span className="text-text-secondary truncate flex-1 mr-2">{t.title}</span>
                <span className="flex items-center gap-1 text-text-muted whitespace-nowrap">
                  {formatDuration(t.avgDuration)}
                  {t.trend === 'improving' && <TrendingDown size={10} className="text-success" />}
                  {t.trend === 'degrading' && <TrendingUp size={10} className="text-error" />}
                  {t.trend === 'stable' && <Minus size={10} className="text-text-muted" />}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Most Failed Test */}
      {trends.overall.mostFailedTest && (
        <div className="bg-error-dim border border-error/20 rounded-lg p-3">
          <div className="text-2xs text-error font-medium mb-0.5">Most Failed Test</div>
          <div className="text-xs text-text-primary">{trends.overall.mostFailedTest.title}</div>
          <div className="text-2xs text-text-muted">{trends.overall.mostFailedTest.failCount} failures</div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-surface-2 border border-border rounded-lg p-2 text-center">
      <div className={`text-base font-bold ${color}`}>{value}</div>
      <div className="text-2xs text-text-muted">{label}</div>
    </div>
  );
}

function PassRateChart({ data }: { data: Array<{ date: string; passRate: number; total: number }> }) {
  const maxRate = 100;
  const height = 40;
  const width = data.length * 20;

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${Math.max(width, 100)} ${height + 16}`} className="w-full" style={{ minHeight: 56 }}>
        {/* Grid lines */}
        {[0, 50, 100].map((val) => (
          <line
            key={val}
            x1="0"
            y1={height - (val / maxRate) * height}
            x2={width}
            y2={height - (val / maxRate) * height}
            stroke="currentColor"
            strokeOpacity="0.1"
            strokeWidth="0.5"
          />
        ))}
        {/* Bars */}
        {data.map((d, i) => {
          const barHeight = (d.passRate / maxRate) * height;
          const x = i * 20 + 2;
          const color = d.passRate >= 80 ? '#22c55e' : d.passRate >= 50 ? '#f59e0b' : '#ef4444';
          return (
            <g key={i}>
              <rect
                x={x}
                y={height - barHeight}
                width="16"
                height={Math.max(barHeight, 1)}
                rx="2"
                fill={color}
                opacity="0.8"
              />
              <text
                x={x + 8}
                y={height + 12}
                textAnchor="middle"
                fontSize="6"
                fill="currentColor"
                opacity="0.4"
              >
                {d.date.slice(5)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m`;
}
