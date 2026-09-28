import type { Job } from "@/lib/api";

const STAGES = [
  { status: "locating", label: "Finding video" },
  { status: "downloading", label: "Downloading" },
  { status: "processing", label: "Processing" },
  { status: "preparing", label: "Preparing download" },
] as const;

function stageIndex(job: Job): number {
  if (job.status === "queued") return 0;
  if (job.status === "complete") return STAGES.length;
  return STAGES.findIndex((s) => s.status === job.status);
}

export default function StageList({ job }: { job: Job }) {
  const current = stageIndex(job);
  return (
    <ol className="space-y-3" aria-live="polite">
      {STAGES.map((stage, i) => {
        const done = i < current;
        const active = i === current;
        const showBar = active && stage.status === "downloading" && job.progress != null;
        return (
          <li key={stage.status} className="flex items-start gap-3">
            <span
              className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-semibold ${
                done
                  ? "bg-emerald-500 text-white"
                  : active
                    ? "bg-accent/10 text-accent ring-2 ring-accent dark:bg-accent/20"
                    : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800"
              }`}
            >
              {done ? (
                <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
                  <path d="M16.7 5.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L8 12.6l7.3-7.3a1 1 0 0 1 1.4 0Z" />
                </svg>
              ) : active ? (
                <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
              ) : (
                i + 1
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p
                className={
                  active
                    ? "font-medium"
                    : done
                      ? "text-zinc-600 dark:text-zinc-400"
                      : "text-zinc-400 dark:text-zinc-600"
                }
              >
                {stage.label}
                {active && job.status === "queued" && (
                  <span className="ml-2 text-sm font-normal text-zinc-500">waiting in queue…</span>
                )}
                {showBar && (
                  <span className="ml-2 text-sm font-normal tabular-nums text-zinc-500">
                    {Math.round((job.progress ?? 0) * 100)}%
                  </span>
                )}
              </p>
              {showBar && (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-500"
                    style={{ width: `${Math.max(3, (job.progress ?? 0) * 100)}%` }}
                  />
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
