from datetime import datetime, timedelta

import pytest

from app.errors import classify_ytdlp_error
from app.signing import LinkState, check_link, download_path
from app.util import new_download_filename, new_id


@pytest.mark.parametrize(
    "stderr, code",
    [
        ("ERROR: [youtube] x: Private video. Sign in if you've been granted access", "restricted"),
        ("ERROR: [Instagram] x: Requested content is not available, rate-limit reached or login required", "restricted"),
        ("ERROR: [youtube] x: Video unavailable. This video has been removed by the uploader", "unavailable"),
        ("ERROR: [youtube] x: Sign in to confirm you’re not a bot.", "platform_blocked"),
        ("ERROR: unable to download video data: HTTP Error 403: Forbidden", "platform_blocked"),
        ("ERROR: [youtube] x: The uploader has not made this video available in your country", "geo_restricted"),
        ("ERROR: [x] This video is DRM protected", "drm_protected"),
        ("ERROR: Unsupported URL: https://www.tiktok.com/", "unsupported_url"),
        ("ERROR: No suitable extractor found for URL https://www.reddit.com/r/videos/", "unsupported_url"),
        ("ERROR: [twitter] 1: No video could be found in this tweet", "no_video"),
        ("ERROR: [TikTok] 1: Unexpected response from webpage request", "extraction_failed"),
        ("WARNING: noise\nERROR: File is larger than max-filesize (1 bytes > 0 bytes). Aborting.", "too_large"),
    ],
)
def test_classify(stderr, code):
    assert classify_ytdlp_error(stderr).code == code


def test_signed_links():
    fid = new_id()
    exp = datetime(2030, 1, 1)
    path = download_path("s3cret", fid, exp)
    assert path.startswith(f"/api/download/{fid}?exp=")
    q = dict(p.split("=") for p in path.split("?", 1)[1].split("&"))
    now = datetime(2029, 12, 31)
    assert check_link("s3cret", fid, q["exp"], q["sig"], now) is LinkState.VALID
    assert check_link("other", fid, q["exp"], q["sig"], now) is LinkState.INVALID
    assert check_link("s3cret", new_id(), q["exp"], q["sig"], now) is LinkState.INVALID
    assert check_link("s3cret", fid, str(int(q["exp"]) + 1), q["sig"], now) is LinkState.INVALID
    assert check_link("s3cret", fid, "abc", q["sig"], now) is LinkState.INVALID
    assert check_link("s3cret", fid, q["exp"], q["sig"], exp + timedelta(seconds=1)) is LinkState.EXPIRED


def test_random_names():
    names = {new_download_filename() for _ in range(1000)}
    assert len(names) == 1000
    import re

    assert all(re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}\.mp4", n) for n in names)
    assert len(new_id()) == 32
