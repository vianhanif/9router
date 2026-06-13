"use client";

import { useState, useEffect } from "react";
import { Card } from "@/shared/components";

function formatDateRange(oldest, newest) {
  if (!oldest && !newest) return "None";
  const fmt = (iso) => {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  };
  if (!newest) return `Since ${fmt(oldest)}`;
  if (!oldest) return `Until ${fmt(newest)}`;
  const o = fmt(oldest);
  const n = fmt(newest);
  return o === n ? o : `${o} \u2013 ${n}`;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "Unknown";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(1)} ${units[i]}`;
}

function Stat({ label, value, icon, subtitle }) {
  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-bg border border-border-subtle">
      <div className="p-2 rounded-lg bg-primary/10 text-primary">
        <span className="material-symbols-outlined text-[18px]">{icon}</span>
      </div>
      <div className="min-w-0">
        <p className="text-xs text-text-muted">{label}</p>
        <p className="font-semibold text-text-main truncate">{value}</p>
        {subtitle && <p className="text-xs text-text-muted mt-0.5">{subtitle}</p>}
      </div>
    </div>
  );
}

export default function DataSummaryCard() {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch("/api/usage/data-summary")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load");
        return res.json();
      })
      .then(setSummary)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <Card>
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-primary/10 text-primary">
            <span className="material-symbols-outlined text-[20px]">storage</span>
          </div>
          <h3 className="text-base sm:text-lg font-semibold">Data Summary</h3>
        </div>
        <div className="grid grid-cols-2 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-16 rounded-lg bg-bg border border-border-subtle animate-pulse" />
          ))}
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-primary/10 text-primary">
            <span className="material-symbols-outlined text-[20px]">storage</span>
          </div>
          <h3 className="text-base sm:text-lg font-semibold">Data Summary</h3>
        </div>
        <p className="text-sm text-text-muted">Failed to load data summary.</p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-lg bg-primary/10 text-primary">
          <span className="material-symbols-outlined text-[20px]">storage</span>
        </div>
        <h3 className="text-base sm:text-lg font-semibold">Data Summary</h3>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Stat label="Months Tracked" value={`${summary.totalMonths} Month${summary.totalMonths !== 1 ? "s" : ""}`} icon="calendar_month" subtitle={formatDateRange(summary.oldestDate, summary.newestDate)} />
        <Stat label="Total Requests" value={summary.totalRequests?.toLocaleString() || "0"} icon="swap_vert" />
        <Stat label="Total Tokens" value={summary.totalTokens?.toLocaleString() || "0"} icon="token" />
        <Stat label="Database Size" value={formatBytes(summary.dbFileSize)} icon="database" />
      </div>
    </Card>
  );
}
