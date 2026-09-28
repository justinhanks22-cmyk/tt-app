export type JobStatus =
  | "queued"
  | "locating"
  | "downloading"
  | "processing"
  | "preparing"
  | "complete"
  | "failed"
  | "expired";

export interface JobResult {
  filename: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  download_url: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  progress: number | null;
  platform: string;
  platform_name: string;
  created_at: string;
  expires_at: string | null;
  error: { code: string; message: string } | null;
  result: JobResult | null;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export const PENDING: JobStatus[] = ["queued", "locating", "downloading", "processing", "preparing"];
export const isPending = (job: Job) => PENDING.includes(job.status);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { cache: "no-store", credentials: "same-origin", ...init });
  } catch {
    throw new ApiError("network", "Couldn't reach the server. Check your connection and try again.", 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error;
    throw new ApiError(err?.code ?? "error", err?.message ?? "Something went wrong. Please try again.", res.status);
  }
  return data as T;
}

export async function createJob(url: string): Promise<Job> {
  const data = await request<{ job: Job }>("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  return data.job;
}

export async function getJob(id: string): Promise<Job> {
  return (await request<{ job: Job }>(`/api/jobs/${id}`)).job;
}

export async function getHistory(): Promise<Job[]> {
  return (await request<{ jobs: Job[] }>("/api/history")).jobs;
}
