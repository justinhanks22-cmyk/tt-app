"""User-facing error codes and the mapping from downloader output to them."""

from __future__ import annotations

import logging
import re

log = logging.getLogger(__name__)


class JobError(Exception):
    """A failure with a stable code and a message that is safe to show to users."""

    def __init__(self, code: str, message: str | None = None):
        self.code = code
        self.message = message or MESSAGES.get(code, MESSAGES["extraction_failed"])
        super().__init__(f"{code}: {self.message}")


MESSAGES: dict[str, str] = {
    "invalid_url": "That doesn't look like a valid video link.",
    "unsupported_url": "This website or link type isn't supported.",
    "unavailable": "This video is unavailable. It may have been deleted or the link is wrong.",
    "restricted": "This video is private or requires signing in, so it can't be downloaded.",
    "geo_restricted": "This video isn't available from this server's region.",
    "drm_protected": "This video is DRM-protected and can't be downloaded.",
    "live_stream": "Live streams can't be downloaded. Try again after the stream has ended.",
    "playlist": "Please paste a link to a single video, not a playlist or profile.",
    "no_video": "No downloadable video was found at that link.",
    "platform_blocked": (
        "The platform refused this server's request (bot check or rate limit). "
        "Try again later."
    ),
    "too_large": "This video is larger than the maximum allowed file size.",
    "too_long": "This video is longer than the maximum allowed duration.",
    "timeout": "Processing took too long and was stopped.",
    "extraction_failed": "The video couldn't be extracted from the platform. Try again later.",
    "processing_failed": "The video was downloaded but couldn't be converted to MP4.",
    "server_busy": "The server is busy right now. Please try again in a few minutes.",
    "worker_lost": "Processing was interrupted. Please try again.",
    "internal_error": "Something went wrong while processing this video.",
}

# Ordered: first match wins. Patterns run against yt-dlp's stderr (case-insensitive).
_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("too_large", re.compile(r"larger than max-filesize|file is larger than", re.I)),
    ("drm_protected", re.compile(r"\bDRM\b", re.I)),
    ("live_stream", re.compile(r"is (currently )?live|live event will begin|premieres in", re.I)),
    (
        "platform_blocked",
        re.compile(
            r"confirm you.?re not a bot|HTTP Error 429|HTTP Error 403|too many requests|"
            r"rate.?limit reached(?! or login)",
            re.I,
        ),
    ),
    (
        "geo_restricted",
        re.compile(r"geo.?restrict|available in your (country|region)|from your location", re.I),
    ),
    (
        "restricted",
        re.compile(
            r"private video|this video is private|is private|login required|log in|sign in|"
            r"logged.?in|requires authentication|cookies|members.only|age.restricted|"
            r"inappropriate for some users|rate-limit reached or login required",
            re.I,
        ),
    ),
    ("unsupported_url", re.compile(r"unsupported url|no suitable extractor", re.I)),
    (
        "unavailable",
        re.compile(
            r"video unavailable|not available|has been removed|no longer available|does not exist|"
            r"was deleted|HTTP Error 404|not found|content isn.?t available",
            re.I,
        ),
    ),
    ("no_video", re.compile(r"no video (formats )?(could be )?found|no video in|requested format is not available", re.I)),
]


def classify_ytdlp_error(stderr: str) -> JobError:
    lines = [ln for ln in stderr.splitlines() if ln.startswith("ERROR:")] or stderr.splitlines()[-5:]
    text = "\n".join(lines)
    # Operator-facing detail stays in the server log; users only get the mapped message.
    log.warning("yt-dlp failed: %s", text[-1000:])
    for code, pattern in _PATTERNS:
        if pattern.search(text):
            return JobError(code)
    return JobError("extraction_failed")
