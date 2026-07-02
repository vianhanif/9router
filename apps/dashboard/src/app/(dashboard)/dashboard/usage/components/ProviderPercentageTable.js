"use client";

import PropTypes from "prop-types";
import { useMemo } from "react";
import Card from "@/shared/components/Card";
import { AI_PROVIDERS } from "@9router/shared/constants/providers";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);

// Fixed palette fallback for providers not in AI_PROVIDERS
const FALLBACK_COLORS = [
  "#3B82F6", "#10B981", "#F59E0B", "#EF4444",
  "#8B5CF6", "#EC4899", "#06B6D4", "#84CC16",
  "#F97316", "#6366F1", "#14B8A6", "#DD2590",
];

function getProviderColor(providerId, index) {
  const config = AI_PROVIDERS[providerId];
  if (config?.color && config.color !== "#ffffffff") return config.color;
  return FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

function ProgressBar({ percent, color }) {
  const clamped = Math.min(Math.max(percent || 0, 0), 100);
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-bg-subtle rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${clamped}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-xs font-medium text-text-muted w-12 text-right">
        {`${clamped.toFixed(1)}%`}
      </span>
    </div>
  );
}

ProgressBar.propTypes = {
  percent: PropTypes.number,
  color: PropTypes.string,
};

/**
 * ProviderPercentageTable — shows per-provider usage breakdown with progress bars.
 *
 * Data is pre-computed with percentages from getMonthlyUsage().
 * Sorted by token percentage descending by default.
 */
export default function ProviderPercentageTable({ byProvider, totals }) {
  const sorted = useMemo(() => {
    return Object.entries(byProvider || {})
      .sort(([, a], [, b]) => (b.tokenPercentage || 0) - (a.tokenPercentage || 0));
  }, [byProvider]);

  if (!byProvider || Object.keys(byProvider).length === 0) {
    return (
      <Card className="p-6 text-center text-text-muted">
        No provider data available for this month.
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="p-4 border-b border-border bg-bg-subtle/50">
        <h3 className="font-semibold">Provider Usage Breakdown</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="bg-bg-subtle/30 text-text-muted uppercase text-xs">
            <tr>
              <th className="px-4 py-3">Provider</th>
              <th className="px-4 py-3 text-right">Requests</th>
              <th className="px-4 py-3 text-right">Request %</th>
              <th className="px-4 py-3 text-right">Tokens</th>
              <th className="px-4 py-3 text-right">Token %</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sorted.map(([provider, stats], idx) => {
              const color = getProviderColor(provider, idx);
              return (
                <tr key={provider} className="hover:bg-bg-subtle/30 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span
                        className="w-3 h-3 rounded-full shrink-0"
                        style={{ backgroundColor: color }}
                      />
                      <span className="font-medium">{provider}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">{fmt(stats.requests)}</td>
                  <td className="px-4 py-3 text-right">
                    <span className="text-xs font-medium">{stats.requestPercentage?.toFixed(1)}%</span>
                  </td>
                  <td className="px-4 py-3 text-right">{fmt(stats.totalTokens)}</td>
                  <td className="px-4 py-3 text-right min-w-[180px]">
                    <ProgressBar percent={stats.tokenPercentage} color={color} />
                  </td>
                </tr>
              );
            })}
            {/* Totals row */}
            <tr className="bg-bg-subtle/20 font-semibold">
              <td className="px-4 py-3">Total</td>
              <td className="px-4 py-3 text-right">{fmt(totals?.requests || 0)}</td>
              <td className="px-4 py-3 text-right">100%</td>
              <td className="px-4 py-3 text-right">{fmt(totals?.totalTokens || 0)}</td>
              <td className="px-4 py-3 text-right min-w-[180px]">
                <ProgressBar percent={100} color="var(--color-primary)" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

ProviderPercentageTable.propTypes = {
  byProvider: PropTypes.object,
  totals: PropTypes.shape({
    requests: PropTypes.number,
    totalTokens: PropTypes.number,
  }),
};
