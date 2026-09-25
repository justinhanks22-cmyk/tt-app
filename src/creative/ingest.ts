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
  filePath: string;
  url?: string;
  caption?: string;
  rightsConfirmed: boolean;
  mediaDir?: string;
  fetchImpl?: typeof fetch;
}): Promise<IngestedVideo> {
  if (!opts.rightsConfirmed) {
    throw new Error(`Stopped: no confirmation that you own or are licensed to use ${opts.url ?? opts.filePath}.`);
  }
  const bytes = readFileSync(opts.filePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const mediaDir = opts.mediaDir ?? "media";
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
  log("info", "creative.ingested", { ...video, original: basename(opts.filePath) });
  return video;
}
