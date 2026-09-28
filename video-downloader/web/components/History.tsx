"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ApiError, getHistory, isPending, type Job } from "@/lib/api";
import { formatBytes, formatDuration, formatResolution, formatTime } from "@/lib/format";
import Countdown from "./Countdown";
import { DownloadButton } from "./ResultCard";

const STATUS_LABEL: Record<Job["status"], string> = {
  queued: "Waiting in queue",
  locating: "Finding video",
  downloading: "Downloading",
  processing: "Processing",
  preparing: "Preparing download",
  complete: "Ready",
  failed: "Failed",
  expired: "Expired",
};

export default function History() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setJobs(await getHistory());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load your videos.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Keep refreshing while anything is still processing.
  const anyPending = jobs?.some(isPending) ?? false;
  useEffect(() => {
    if (!anyPending) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [anyPending, load]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">My videos</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Videos you processed in this browser session. Each file is deleted 24 hours after it was created.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {jobs === null && !error && <p className="text-zinc-500">Loading…</p>}

      {jobs?.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-zinc-600 dark:text-zinc-400">No videos yet in this session.</p>
          <Link href="/" className="btn-primary mt-4">
            Download a video
          </Link>
        </div>
      )}

      <ul className="space-y-3">
        {jobs?.map((job) => (
          <li key={job.id} className="card p-4 sm:p-5">
            <HistoryItem job={job} onExpire={load} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function HistoryItem({ job, onExpire }: { job: Job; onExpire: () => void }) {
  const r = job.result;
  const tone =
    job.status === "complete"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400"
      : job.status === "failed"
        ? "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400"
        : job.status === "expired"
          ? "bg-zinc-100 text-zinc-500 dark:bg-zinc-800"
          : "bg-accent/10 text-accent";
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{job.platform_name}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
            {STATUS_LABEL[job.status]}
            {job.status === "downloading" && job.progress != null ? ` ${Math.round(job.progress * 100)}%` : ""}
          </span>
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          {r
            ? `${formatResolution(r.width, r.height)} · ${formatBytes(r.size_bytes)} · ${formatDuration(r.duration)}`
            : job.status === "failed"
              ? job.error?.message
              : formatTime(job.created_at)}
        </p>
        {r && job.expires_at && (
          <p className="mt-0.5 text-xs text-zinc-500">
            <Countdown expiresAt={job.expires_at} onExpire={onExpire} />
          </p>
        )}
      </div>
      {r && <DownloadButton result={r} className="shrink-0 py-2.5 text-sm" />}
    </div>
  );
}
