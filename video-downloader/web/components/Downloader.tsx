"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, createJob, getJob, isPending, type Job } from "@/lib/api";
import ResultCard from "./ResultCard";
import StageList from "./StageList";

const CURRENT_JOB_KEY = "vd:current-job";
const PLATFORMS = ["TikTok", "Instagram", "Facebook", "YouTube", "X"];

function storage(action: "get" | "set" | "remove", value?: string): string | null {
  try {
    if (action === "get") return sessionStorage.getItem(CURRENT_JOB_KEY);
    if (action === "set") sessionStorage.setItem(CURRENT_JOB_KEY, value!);
    else sessionStorage.removeItem(CURRENT_JOB_KEY);
  } catch {
    /* storage unavailable (private mode etc.): resuming after reload just won't work */
  }
  return null;
}

export default function Downloader() {
  const [url, setUrl] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Resume the job in progress after a page reload.
  useEffect(() => {
    const id = storage("get");
    if (id) getJob(id).then(setJob).catch(() => storage("remove"));
  }, []);

  // Poll the job until it reaches a terminal state.
  const jobId = job?.id;
  const pending = job ? isPending(job) : false;
  useEffect(() => {
    if (!jobId || !pending) return;
    let cancelled = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = await getJob(jobId);
        failures = 0;
        if (!cancelled) setJob(next);
        if (!isPending(next)) return;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          if (!cancelled) setJob(null);
          storage("remove");
          return;
        }
        failures++;
      }
      if (!cancelled) timer = setTimeout(tick, Math.min(1000 * 2 ** failures, 10_000));
    };
    timer = setTimeout(tick, 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jobId, pending]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = url.trim();
    if (!value) {
      setFormError("Paste a video link first.");
      inputRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const created = await createJob(value);
      setJob(created);
      storage("set", created.id);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const reset = useCallback(() => {
    setJob(null);
    setUrl("");
    setFormError(null);
    storage("remove");
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const markExpired = useCallback(() => setJob((j) => (j ? { ...j, status: "expired", result: null } : j)), []);

  const busy = submitting || pending;

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Video Downloader</h1>
        <p className="mt-3 text-zinc-600 dark:text-zinc-400">
          Paste TikTok, Instagram, Facebook, YouTube or other supported video URL
        </p>
      </div>

      <form onSubmit={submit} className="card p-2" noValidate>
        <div className="flex flex-col gap-2 sm:flex-row">
          <label htmlFor="url" className="sr-only">
            Video URL
          </label>
          <input
            ref={inputRef}
            id="url"
            type="url"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus
            placeholder="https://www.tiktok.com/@user/video/…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={busy}
            aria-invalid={formError ? true : undefined}
            aria-describedby={formError ? "url-error" : undefined}
            className="min-w-0 flex-1 rounded-xl bg-transparent px-4 py-3 text-base outline-none placeholder:text-zinc-400 disabled:opacity-60"
          />
          <button type="submit" className="btn-primary" disabled={busy}>
            {submitting ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            ) : null}
            Download Video
          </button>
        </div>
      </form>

      {formError && (
        <p id="url-error" role="alert" className="-mt-3 px-2 text-sm text-red-600 dark:text-red-400">
          {formError}
        </p>
      )}

      {!job && (
        <p className="text-center text-sm text-zinc-500">
          Works with {PLATFORMS.join(" · ")} and more. Public videos only.
        </p>
      )}

      {job && pending && (
        <section className="card p-6 sm:p-8">
          <p className="mb-5 text-sm text-zinc-500">Getting your {job.platform_name} video…</p>
          <StageList job={job} />
        </section>
      )}

      {job?.status === "complete" && job.result && <ResultCard job={job} onExpire={markExpired} />}

      {job?.status === "failed" && (
        <section className="card border-red-200 p-6 dark:border-red-900/60" role="alert">
          <h2 className="font-semibold text-red-700 dark:text-red-400">Couldn&apos;t download this video</h2>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">{job.error?.message}</p>
        </section>
      )}

      {job?.status === "expired" && (
        <section className="card p-6">
          <h2 className="font-semibold">This download has expired</h2>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            Files are permanently deleted 24 hours after processing. Paste the link again to make a new one.
          </p>
        </section>
      )}

      {job && !pending && (
        <div className="text-center">
          <button type="button" onClick={reset} className="btn-secondary">
            Download another video
          </button>
        </div>
      )}
    </div>
  );
}
