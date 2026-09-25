import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { log } from "../log/logger.js";

/** A video ready to upload, with where it came from and what TikTok says about it. */
export interface IngestedVideo {
  sourceUrl?: string;
  sourcePostId?: string;
  sourceAuthor?: string;
  caption: string;
  filePath: string;
  coverPath: string;
  sha256: string;
  width: number;
  height: number;
  durationSec: number;
  bitrate: number;
  rightsConfirmed: boolean;
}

/** Caption/author/post ID for a TikTok URL from TikTok's official oEmbed endpoint. */
export async function tiktokPostInfo(url: string, fetchImpl: typeof fetch = fetch) {
  const res = await fetchImpl(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`TikTok oEmbed failed for ${url}: HTTP ${res.status}`);
  const d = (await res.json()) as { title?: string; author_unique_id?: string; embed_product_id?: string };
  return { caption: d.title ?? "", author: d.author_unique_id, postId: d.embed_product_id };
}

export function probeVideo(filePath: string) {
  const out = execFileSync(ffprobe.path, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,bit_rate:format=duration,bit_rate", "-of", "json", filePath,
  ]).toString();
  const d = JSON.parse(out) as { streams: { width: number; height: number; bit_rate?: string }[]; format: { duration: string; bit_rate?: string } };
  const s = d.streams[0];
  if (!s) throw new Error(`${filePath} has no video stream`);
  return { width: s.width, height: s.height, durationSec: Number(d.format.duration), bitrate: Number(s.bit_rate ?? d.format.bit_rate ?? 0) };
}

export class DownloadBlockedError extends Error {}

type Exec = (cmd: string, args: string[]) => string;
const defaultExec: Exec = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * Downloads a TikTok video from its link with yt-dlp as an ordinary request,
 * taking only a non-watermarked format. It never disguises itself as a
 * browser: if yt-dlp's browser impersonation (curl_cffi) is installed, it
 * refuses to run, and if TikTok blocks the request, it stops and asks for the
 * original file instead of working around the block.
 */
export function downloadTikTok(url: string, destDir: string, exec: Exec = defaultExec): string {
  try {
    exec("python3", ["-c", "import curl_cffi"]);
    throw new DownloadBlockedError("curl_cffi is installed, which lets yt-dlp impersonate a browser. Uninstall it (pip uninstall curl_cffi); this app only makes ordinary requests.");
  } catch (err) {
    if (err instanceof DownloadBlockedError) throw err; // import succeeded → refuse
  }
  mkdirSync(destDir, { recursive: true });
  try {
    const out = exec("yt-dlp", [
      "--no-playlist", "--no-warnings", "--no-progress",
      "-f", "b[format_note!*=watermark]/bv*[format_note!*=watermark]+ba", // never the watermarked file
      "-o", join(destDir, "%(id)s.%(ext)s"),
      "--print", "after_move:filepath",
      url,
    ]);
    const path = out.trim().split("\n").pop();
    if (!path) throw new Error("yt-dlp returned no file");
    log("info", "creative.downloaded", { url, path });
    return path;
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? err);
    log("error", "creative.download_failed", { url, stderr: stderr.slice(-2000) });
    const reason = /Requested format is not available/i.test(stderr)
      ? "TikTok offers no watermark-free version of this video"
      : "TikTok refused the download request";
    throw new DownloadBlockedError(`${reason} (${url}). Send the original video file for this link instead.`);
  }
}

/** First-second frame as a JPEG cover (Spark Ads Push needs a cover image). */
export function extractCover(filePath: string, outPath: string): string {
  execFileSync(ffmpegPath as unknown as string, ["-y", "-v", "error", "-ss", "1", "-i", filePath, "-frames:v", "1", "-q:v", "2", outPath]);
  return outPath;
}

/**
 * ingestCreative(): prepares one creative from the original video file.
 * `url` (optional) is the TikTok link it came from; its caption is fetched
 * through TikTok's official oEmbed and kept as the ad text. Nothing is
 * processed unless `rightsConfirmed` is true.
 */
export async function ingestCreative(opts: {
  /** Original file; if omitted, the video is downloaded from `url`. */
  filePath?: string;
  url?: string;
  caption?: string;
  rightsConfirmed: boolean;
  mediaDir?: string;
  fetchImpl?: typeof fetch;
  exec?: Exec;
}): Promise<IngestedVideo> {
  if (!opts.rightsConfirmed) {
    throw new Error(`Stopped: no confirmation that you own or are licensed to use ${opts.url ?? opts.filePath}.`);
  }
  const mediaDir = opts.mediaDir ?? "media";
  let source = opts.filePath;
  if (!source) {
    if (!opts.url) throw new Error("A creative needs a TikTok link or a video file.");
    source = downloadTikTok(opts.url, join(mediaDir, "downloads"), opts.exec);
  }
  const bytes = readFileSync(source);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  mkdirSync(mediaDir, { recursive: true });
  const stored = join(mediaDir, `${sha256.slice(0, 16)}.mp4`);
  writeFileSync(stored, bytes);
  const coverPath = extractCover(stored, join(mediaDir, `${sha256.slice(0, 16)}-cover.jpg`));
  const info = opts.url ? await tiktokPostInfo(opts.url, opts.fetchImpl) : undefined;
  const video: IngestedVideo = {
    sourceUrl: opts.url,
    sourcePostId: info?.postId,
    sourceAuthor: info?.author,
    caption: opts.caption ?? info?.caption ?? "",
    filePath: stored,
    coverPath,
    sha256,
    ...probeVideo(stored),
    rightsConfirmed: true,
  };
  log("info", "creative.ingested", { ...video, original: basename(source) });
  return video;
}
