import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { describe, expect, it, vi } from "vitest";
import { downloadTikTok, DownloadBlockedError, ingestCreative } from "../src/creative/ingest.js";

const URL_ = "https://www.tiktok.com/@creator/video/7000000000000000001";
const noCurlCffi = (cmd: string) => {
  if (cmd === "python3") throw new Error("ModuleNotFoundError: No module named 'curl_cffi'");
};

describe("downloadTikTok", () => {
  it("asks yt-dlp only for a watermark-free format and returns the file", () => {
    const calls: string[][] = [];
    const exec = (cmd: string, args: string[]) => {
      noCurlCffi(cmd);
      calls.push(args);
      return "/tmp/x/7000000000000000001.mp4\n";
    };
    expect(downloadTikTok(URL_, "/tmp/x", exec)).toBe("/tmp/x/7000000000000000001.mp4");
    const args = calls[0]!;
    expect(args[args.indexOf("-f") + 1]).toBe("b[format_note!*=watermark]/bv*[format_note!*=watermark]+ba");
    expect(args).not.toContain("--impersonate");
  });

  it("refuses to run when browser impersonation (curl_cffi) is installed", () => {
    const exec = vi.fn(() => "");
    expect(() => downloadTikTok(URL_, "/tmp/x", exec)).toThrow(/impersonate/);
    expect(exec).toHaveBeenCalledTimes(1); // yt-dlp never ran
  });

  it("stops with a clear message when TikTok blocks the request", () => {
    const exec = (cmd: string) => {
      noCurlCffi(cmd);
      throw Object.assign(new Error("fail"), { stderr: "ERROR: [TikTok] Unexpected response from webpage request" });
    };
    expect(() => downloadTikTok(URL_, "/tmp/x", exec)).toThrow(DownloadBlockedError);
    expect(() => downloadTikTok(URL_, "/tmp/x", exec)).toThrow(/refused the download.*Send the original video file/);
  });

  it("won't fall back to a watermarked version", () => {
    const exec = (cmd: string) => {
      noCurlCffi(cmd);
      throw Object.assign(new Error("fail"), { stderr: "ERROR: Requested format is not available" });
    };
    expect(() => downloadTikTok(URL_, "/tmp/x", exec)).toThrow(/no watermark-free version/);
  });

  it("ingestCreative downloads from the link when no file is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-"));
    const fakeDownload = join(dir, "dl.mp4");
    execFileSync(ffmpegPath as unknown as string, ["-v", "error", "-f", "lavfi", "-i", "color=c=green:s=1080x1920:d=2", "-pix_fmt", "yuv420p", fakeDownload]);
    const exec = (cmd: string) => {
      noCurlCffi(cmd);
      return `${fakeDownload}\n`;
    };
    const fetchImpl = vi.fn(async () => Response.json({ title: "so cute $29 today", author_unique_id: "creator", embed_product_id: "7000000000000000001" }));
    const v = await ingestCreative({ url: URL_, rightsConfirmed: true, mediaDir: join(dir, "media"), exec, fetchImpl });
    expect(v).toMatchObject({ width: 1080, height: 1920, caption: "so cute $29 today", sourcePostId: "7000000000000000001" });
  });
});
