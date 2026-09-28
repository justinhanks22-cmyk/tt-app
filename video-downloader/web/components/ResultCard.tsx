import type { Job, JobResult } from "@/lib/api";
import { formatBytes, formatDuration, formatResolution } from "@/lib/format";
import Countdown from "./Countdown";

export function DownloadButton({ result, className = "" }: { result: JobResult; className?: string }) {
  return (
    <a href={result.download_url} download={result.filename} className={`btn-primary ${className}`}>
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 20h14" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Download MP4
    </a>
  );
}

export default function ResultCard({ job, onExpire }: { job: Job; onExpire?: () => void }) {
  const result = job.result!;
  return (
    <section className="card p-6 sm:p-8">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">
          <svg viewBox="0 0 20 20" className="h-5 w-5" fill="currentColor" aria-hidden>
            <path d="M16.7 5.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L8 12.6l7.3-7.3a1 1 0 0 1 1.4 0Z" />
          </svg>
        </span>
        <div>
          <h2 className="text-lg font-semibold">Your video is ready</h2>
          <p className="text-sm text-zinc-500">{job.platform_name}</p>
        </div>
      </div>

      <dl className="mt-6 grid grid-cols-3 divide-x divide-zinc-200 rounded-xl bg-zinc-50 py-3 text-center dark:divide-zinc-800 dark:bg-zinc-950/60">
        <Stat label="Resolution" value={formatResolution(result.width, result.height)} />
        <Stat label="Size" value={formatBytes(result.size_bytes)} />
        <Stat label="Duration" value={formatDuration(result.duration)} />
      </dl>

      <DownloadButton result={result} className="mt-6 w-full" />

      <p className="mt-4 flex items-center justify-center gap-1.5 text-sm text-zinc-500">
        <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden>
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-12.25a.75.75 0 0 0-1.5 0V10c0 .2.08.39.22.53l2.5 2.5a.75.75 0 1 0 1.06-1.06l-2.28-2.28V5.75Z"
            clipRule="evenodd"
          />
        </svg>
        {job.expires_at && <Countdown expiresAt={job.expires_at} onExpire={onExpire} />}
      </p>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-2">
      <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="mt-1 font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
