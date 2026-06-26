"use client";

import { useState, useEffect, useCallback } from "react";
import PropTypes from "prop-types";
import {
  AreaChart,
  Area,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import Card from "@/shared/components/Card";

const fmtTokens = (n) => {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n || 0);
};

const fmtCost = (n) => `$${(n || 0).toFixed(4)}`;

const fmtLabel = (label) => {
  if (!label) return "";
  if (label.includes(":")) return label;
  const d = new Date(label + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

export default function UsageChart({ period = "7d", month, cutoffDay }) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState("tokens");
  const [granularity, setGranularity] = useState(() => ["today", "24h"].includes(period) ? "hour" : "day");
  const [drillTarget, setDrillTarget] = useState(null);

  const drillLabel = granularity === "hour" && drillTarget?.dateKey
    ? new Date(drillTarget.dateKey + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : granularity === "minute" && drillTarget?.dateKey && drillTarget?.hour !== undefined
    ? `${new Date(drillTarget.dateKey + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${String(drillTarget.hour).padStart(2, "0")}:00`
    : "";

  const fetchData = useCallback(async () => {
    if (period === "monthly" && (cutoffDay == null) && granularity === "day") return;
    setLoading(true);
    try {
      let url;
      if (granularity === "hour" && drillTarget?.dateKey) {
        url = `/api/usage/chart?granularity=hour&dateKey=${drillTarget.dateKey}`;
      } else if (granularity === "minute" && drillTarget?.dateKey && drillTarget?.hour !== undefined) {
        url = `/api/usage/chart?granularity=minute&dateKey=${drillTarget.dateKey}&hour=${drillTarget.hour}`;
      } else {
        url = `/api/usage/chart?period=${period}`;
        if (period === "monthly") {
          url += `&month=${month}&cutoffDay=${cutoffDay}`;
        }
      }
      const res = await fetch(url);
      if (res.ok) {
        let json = await res.json();
        if (granularity === "hour") {
          json = json.map((d, i) => ({ ...d, hourIndex: i }));
        }
        setData(json);
      }
    } catch (e) {
      console.error("Failed to fetch chart data:", e);
    } finally {
      setLoading(false);
    }
  }, [period, month, cutoffDay, granularity, drillTarget]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    setGranularity(["today", "24h"].includes(period) ? "hour" : "day");
    setDrillTarget(null);
  }, [period]);

  const handleDataPointClick = (pointData) => {
    if (!pointData) return;

    if (granularity === "day" && pointData.dateKey) {
      setDrillTarget({ dateKey: pointData.dateKey });
      setGranularity("hour");
    } else if (granularity === "hour") {
      const hour = pointData.hour !== undefined ? pointData.hour : pointData.hourIndex;
      const dateKey = pointData.dateKey || drillTarget?.dateKey;
      if (hour !== undefined && dateKey) {
        setDrillTarget({ dateKey, hour });
        setGranularity("minute");
      }
    }
  };

  const handleBack = () => {
    if (granularity === "minute") {
      setDrillTarget(prev => ({ dateKey: prev.dateKey }));
      setGranularity("hour");
    } else {
      setDrillTarget(null);
      setGranularity("day");
    }
  };

  const hasData = data.some((d) => d.tokens > 0 || d.cost > 0);
  const xInterval = (granularity === "minute" || period === "monthly") && data.length > 0
    ? Math.max(1, Math.floor(data.length / 5))
    : "preserveStartEnd";

  return (
    <Card className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
      <div className="flex items-center gap-2">
        {granularity !== "day" && (
          <button
            onClick={handleBack}
            className="flex items-center gap-1 text-sm text-text-muted hover:text-text transition-colors whitespace-nowrap"
          >
            <span className="text-base">←</span>
            Back {drillLabel ? `(${drillLabel})` : ""}
          </button>
        )}
        <div className="grid w-full grid-cols-2 items-center gap-1 rounded-lg border border-border bg-bg-subtle p-1 sm:w-auto sm:self-start">
          <button
            onClick={() => setViewMode("tokens")}
            className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === "tokens" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
          >
            Tokens
          </button>
          <button
            onClick={() => setViewMode("cost")}
            className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === "cost" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
          >
            Cost
          </button>
        </div>
      </div>

      {loading ? (
        <div className="h-48 flex items-center justify-center text-text-muted text-sm">Loading...</div>
      ) : !hasData ? (
        <div className="h-48 flex items-center justify-center text-text-muted text-sm">No data for this period</div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart
            data={data}
            margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
            className={granularity !== "minute" ? "cursor-pointer" : ""}
          >
            <defs>
              <linearGradient id="gradTokens" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gradCost" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              interval={xInterval}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={viewMode === "tokens" ? fmtTokens : fmtCost}
              width={50}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                fontSize: "12px",
              }}
              formatter={(value, name) =>
                name === "tokens" ? [fmtTokens(value), "Tokens"] : [fmtCost(value), "Cost"]
              }
              labelFormatter={fmtLabel}
            />
            {viewMode === "tokens" ? (
              <Area
                type="monotone"
                dataKey="tokens"
                stroke="#6366f1"
                strokeWidth={2}
                fill="url(#gradTokens)"
                dot={false}
                activeDot={{ r: 4 }}
              />
            ) : (
              <Area
                type="monotone"
                dataKey="cost"
                stroke="#f59e0b"
                strokeWidth={2}
                fill="url(#gradCost)"
                dot={false}
                activeDot={{ r: 4 }}
              />
            )}
            {granularity !== "minute" && (
              <Bar
                dataKey={viewMode === "tokens" ? "tokens" : "cost"}
                fill="transparent"
                opacity={0}
                cursor="pointer"
                onClick={(data) => handleDataPointClick(data)}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

UsageChart.propTypes = {
  period: PropTypes.string,
  month: PropTypes.string,
  cutoffDay: PropTypes.number,
};
