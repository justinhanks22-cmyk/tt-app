import pytest

from app import url_validation
from app.errors import JobError
from app.url_validation import _is_public_ip, validate_url


@pytest.mark.parametrize(
    "url, platform",
    [
        ("https://www.tiktok.com/@user/video/7234567890123456789", "tiktok"),
        ("https://vm.tiktok.com/ZMabc123/", "tiktok"),
        ("https://www.instagram.com/reel/Cabc123/", "instagram"),
        ("https://www.facebook.com/watch/?v=123", "facebook"),
        ("https://fb.watch/abc123/", "facebook"),
        ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"),
        ("https://youtu.be/dQw4w9WgXcQ", "youtube"),
        ("https://www.youtube.com/shorts/abc123", "youtube_shorts"),
        ("https://x.com/user/status/123", "twitter"),
        ("https://twitter.com/user/status/123", "twitter"),
        ("https://www.reddit.com/r/videos/comments/abc/title/", "reddit"),
        ("tiktok.com/@user/video/1", "tiktok"),  # scheme added automatically
        ("  https://WWW.TikTok.COM./@user/video/1  ", "tiktok"),
    ],
)
def test_detects_platform(url, platform):
    assert validate_url(url).platform.id == platform


@pytest.mark.parametrize(
    "url, code",
    [
        ("", "invalid_url"),
        ("not a url", "invalid_url"),
        ("ftp://www.tiktok.com/x", "invalid_url"),
        ("file:///etc/passwd", "invalid_url"),
        ("javascript:alert(1)", "invalid_url"),
        ("http://www.tiktok.com/@u/video/1", "invalid_url"),  # http disabled by default
        ("https://user:pass@www.tiktok.com/@u/video/1", "invalid_url"),
        ("https://www.tiktok.com@evil.com/x", "invalid_url"),
        ("https://www.tiktok.com:8080/@u/video/1", "invalid_url"),
        ("https://127.0.0.1/video.mp4", "unsupported_url"),
        ("https://[::1]/video.mp4", "unsupported_url"),
        ("https://169.254.169.254/latest/meta-data/", "unsupported_url"),
        ("https://example.com/video.mp4", "unsupported_url"),
        ("https://tiktok.com.evil.com/x", "unsupported_url"),
        ("https://eviltiktok.com/x", "unsupported_url"),
        ("https://www.tiktok.com/@u/video/1\n--exec=rm", "invalid_url"),
        ("https://www.tiktok.com/@u/video/1 --exec rm", "invalid_url"),
        ("https://www.tiktok.com/" + "a" * 3000, "invalid_url"),
    ],
)
def test_rejects(url, code):
    with pytest.raises(JobError) as exc:
        validate_url(url)
    assert exc.value.code == code


def test_http_allowed_when_configured():
    assert validate_url("http://www.tiktok.com/@u/video/1", allow_http=True).url.startswith("http://")


def test_other_platforms_can_be_disabled():
    with pytest.raises(JobError):
        validate_url("https://www.reddit.com/r/x/comments/1/", enable_other=False)
    assert validate_url("https://www.tiktok.com/@u/video/1", enable_other=False).platform.id == "tiktok"


def test_extra_domains():
    v = validate_url("https://videos.example.org/watch/1", extra_domains=["example.org"])
    assert v.platform.id == "other"
    assert v.platform.allows_extractor("SomeSite")
    assert not v.platform.allows_extractor("Generic")


def test_normalization_strips_tracking_and_fragment():
    v = validate_url("https://www.youtube.com/watch?v=abc&si=track&utm_source=x&t=10#comments")
    assert v.url == "https://www.youtube.com/watch?v=abc&t=10"
    v = validate_url("https://www.instagram.com/reel/C1/?igsh=abc")
    assert v.url == "https://www.instagram.com/reel/C1/"


@pytest.mark.parametrize(
    "addr, public",
    [
        ("8.8.8.8", True),
        ("2606:4700:4700::1111", True),
        ("10.0.0.1", False),
        ("172.16.5.4", False),
        ("192.168.1.1", False),
        ("127.0.0.1", False),
        ("169.254.169.254", False),
        ("100.64.0.1", False),
        ("0.0.0.0", False),
        ("::1", False),
        ("fd00::1", False),
        ("fe80::1", False),
        ("::ffff:127.0.0.1", False),
        ("224.0.0.1", False),
    ],
)
def test_public_ip_check(addr, public):
    assert _is_public_ip(addr) is public


def test_dns_resolving_to_private_address_is_rejected(monkeypatch):
    monkeypatch.undo()  # re-enable the real resolve_public
    monkeypatch.setattr(
        url_validation.socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("10.1.2.3", 443))]
    )
    with pytest.raises(JobError) as exc:
        validate_url("https://www.tiktok.com/@u/video/1")
    assert exc.value.code == "invalid_url"
