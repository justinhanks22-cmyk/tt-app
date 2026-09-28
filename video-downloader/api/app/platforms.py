"""Supported platforms: which domains are accepted and which yt-dlp extractors may handle them.

To add a platform, append a `Platform` entry. `extractors` are regexes matched against yt-dlp's
`extractor_key`; a download is rejected if yt-dlp resolved the URL with any other extractor, so
the server can't be turned into a generic fetcher for arbitrary pages.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Platform:
    id: str
    name: str
    domains: tuple[str, ...]
    extractors: tuple[str, ...]
    primary: bool = True  # primary platforms are always enabled; others via ENABLE_OTHER_PLATFORMS
    _patterns: tuple[re.Pattern[str], ...] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "_patterns", tuple(re.compile(p) for p in self.extractors))

    def matches_host(self, host: str) -> bool:
        return any(host == d or host.endswith("." + d) for d in self.domains)

    def allows_extractor(self, extractor_key: str) -> bool:
        return any(p.fullmatch(extractor_key) for p in self._patterns)


PLATFORMS: tuple[Platform, ...] = (
    Platform("tiktok", "TikTok", ("tiktok.com",), (r"TikTok\w*",)),
    Platform("instagram", "Instagram", ("instagram.com", "instagr.am"), (r"Instagram\w*",)),
    Platform("facebook", "Facebook", ("facebook.com", "fb.watch", "fb.com"), (r"Facebook\w*",)),
    Platform(
        "youtube",
        "YouTube",
        ("youtube.com", "youtu.be", "youtube-nocookie.com"),
        (r"Youtube\w*",),
    ),
    Platform("twitter", "X / Twitter", ("x.com", "twitter.com"), (r"Twitter\w*",)),
    # "Other" platforms supported by yt-dlp. Disable all of them with ENABLE_OTHER_PLATFORMS=false.
    Platform("reddit", "Reddit", ("reddit.com", "redd.it"), (r"Reddit\w*",), primary=False),
    Platform("vimeo", "Vimeo", ("vimeo.com",), (r"Vimeo\w*",), primary=False),
    Platform("dailymotion", "Dailymotion", ("dailymotion.com", "dai.ly"), (r"Dailymotion\w*",), primary=False),
    Platform("twitch", "Twitch", ("twitch.tv",), (r"Twitch\w*",), primary=False),
    Platform("streamable", "Streamable", ("streamable.com",), (r"Streamable",), primary=False),
    Platform("bluesky", "Bluesky", ("bsky.app",), (r"Bluesky",), primary=False),
    Platform("archive_org", "Internet Archive", ("archive.org",), (r"ArchiveOrg",), primary=False),
)

# Extra domains configured by the operator use yt-dlp's own site extractors (never "Generic").
EXTRA_PLATFORM_ID = "other"


def display_name(platform_id: str) -> str:
    if platform_id == "youtube_shorts":
        return "YouTube Shorts"
    for p in PLATFORMS:
        if p.id == platform_id:
            return p.name
    return "Other"


def enabled_platforms(enable_other: bool) -> list[Platform]:
    return [p for p in PLATFORMS if p.primary or enable_other]


def detect_platform(host: str, path: str, enable_other: bool, extra_domains: list[str]) -> Platform | None:
    for p in enabled_platforms(enable_other):
        if p.matches_host(host):
            if p.id == "youtube" and path.startswith("/shorts/"):
                return Platform("youtube_shorts", "YouTube Shorts", p.domains, p.extractors)
            return p
    if any(host == d or host.endswith("." + d) for d in extra_domains):
        # Any dedicated (non-generic) yt-dlp extractor is acceptable for operator-approved domains.
        return Platform(EXTRA_PLATFORM_ID, "Other", tuple(extra_domains), (r"(?!Generic$)\w+",), primary=False)
    return None
