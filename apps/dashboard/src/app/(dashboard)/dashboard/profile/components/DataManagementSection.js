"use client";

import { useState, useEffect } from "react";
import { Card, Button } from "@/shared/components";
import Modal from "@/shared/components/Modal";
import { useNotificationStore } from "@/store/notificationStore";

const RETENTION_OPTIONS = [
  { value: "all", label: "Keep All" },
  { value: "12", label: "12 months" },
  { value: "6", label: "6 months" },
  { value: "3", label: "3 months" },
  { value: "1", label: "1 month" },
];

export default function DataManagementSection({ onDataCleared }) {
  const [expanded, setExpanded] = useState(false);
  const [retentionMonths, setRetentionMonths] = useState("all");
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const isKeepAll = retentionMonths === "all";

  useEffect(() => {
    if (isKeepAll) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    fetch(`/api/usage/clear?action=dry-run&months=${retentionMonths}`)
      .then((r) => {
        if (!r.ok) throw new Error("Failed to get preview");
        return r.json();
      })
      .then(setPreview)
      .catch((err) => setPreviewError(err.message))
      .finally(() => setPreviewLoading(false));
  }, [retentionMonths, isKeepAll]);

  const handleClear = async () => {
    setDeleting(true);
    try {
      const res = await fetch("/api/usage/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ months: parseInt(retentionMonths, 10) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to clear data");

      const cutoffDisplay = data.cutoffDate ? new Date(data.cutoffDate).toISOString().slice(0, 10) : "";
      useNotificationStore.getState().success(
        `Deleted ${data.deletedRows} records (before ${cutoffDisplay}). Hard refresh (F5/Cmd+R) to update usage charts.`,
        "Data Cleared"
      );
      setConfirmOpen(false);
      setRetentionMonths("all");
      setPreview(null);
      onDataCleared?.();
    } catch (err) {
      useNotificationStore.getState().error(err.message, "Clear Failed");
    } finally {
      setDeleting(false);
    }
  };

  const previewCount = preview?.preview?.historyCount;
  const previewFrom = preview?.preview?.dateRange?.from;
  const previewTo = preview?.preview?.dateRange?.to;

  return (
    <Card>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 text-left"
      >
        <div className="p-2 rounded-lg bg-red-500/10 text-red-500 shrink-0">
          <span className="material-symbols-outlined text-[20px]">delete_sweep</span>
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base sm:text-lg font-semibold">Data Management</h3>
          <p className="text-xs text-text-muted">
            Clear old usage history to free up disk space
          </p>
        </div>
        <span className="material-symbols-outlined text-text-muted shrink-0">
          {expanded ? "expand_less" : "expand_more"}
        </span>
      </button>

      {expanded && (
        <div className="flex flex-col gap-4 mt-4">
          <p className="text-xs sm:text-sm text-text-muted">
            Select how many months of usage data to keep. All data older than the selected period will be permanently deleted. This action cannot be undone.
          </p>

          <div className="flex flex-col gap-2">
            <label className="font-medium text-sm sm:text-base">Retention Period</label>
            <select
              value={retentionMonths}
              onChange={(e) => setRetentionMonths(e.target.value)}
              className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text-main focus:outline-none focus:ring-2 focus:ring-primary/50 sm:w-auto"
              style={{ colorScheme: "auto" }}
            >
              {RETENTION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {preview && (
            <div className="rounded-lg border border-border bg-bg p-3 text-sm space-y-1">
              {preview.oldestDate && (
                <p className="text-text-muted">
                  Oldest record: <span className="font-mono">{preview.oldestDate.slice(0, 10)}</span>
                  {preview.totalMonths > 0 && (
                    <> &middot; {preview.totalMonths} month{preview.totalMonths > 1 ? "s" : ""} tracked</>
                  )}
                </p>
              )}
              {previewCount > 0 && (
                <p className="text-red-600 dark:text-red-400 font-medium">
                  {previewCount.toLocaleString()} rows will be deleted
                  {previewFrom && previewTo && (
                    <> ({previewFrom.slice(0, 10)} to {previewTo.slice(0, 10)})</>
                  )}
                </p>
              )}
              {previewCount === 0 && (
                <p className="text-text-muted">No data older than the selected period.</p>
              )}
            </div>
          )}

          {previewLoading && (
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <span className="material-symbols-outlined text-[16px] animate-spin">progress_activity</span>
              Estimating data to clear...
            </div>
          )}

          {previewError && (
            <p className="text-sm text-red-500">Failed to estimate: {previewError}</p>
          )}

          <div className="pt-2 border-t border-border/50">
            <Button
              variant="danger"
              icon="delete"
              onClick={() => setConfirmOpen(true)}
              disabled={isKeepAll || previewCount === 0 || previewLoading || !!previewError}
              className="w-full sm:w-auto"
            >
              Clear Old Data
            </Button>
          </div>
        </div>
      )}

      <Modal
        isOpen={confirmOpen}
        onClose={() => !deleting && setConfirmOpen(false)}
        title="Clear Usage Data?"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleClear} loading={deleting}>
              Yes, Delete {previewCount?.toLocaleString() || ""} Rows
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
            <span className="material-symbols-outlined text-red-500 text-[18px]">warning</span>
            <p className="text-red-600 dark:text-red-400 font-medium">
              This action cannot be undone.
            </p>
          </div>
          <ul className="space-y-2 text-text-muted">
            <li><strong>Rows to delete:</strong> {previewCount?.toLocaleString() || 0}</li>
            {previewFrom && previewTo && (
              <li><strong>Date range:</strong> {previewFrom.slice(0, 10)} to {previewTo.slice(0, 10)}</li>
            )}
            <li>All data older than {retentionMonths} month{retentionMonths > 1 ? "s" : ""} will be permanently removed.</li>
          </ul>
        </div>
      </Modal>
    </Card>
  );
}
