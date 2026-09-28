"""Validation and normalization of untrusted, user-submitted URLs.

Defenses:
* only https:// (and optionally http://), no credentials, default ports only
* hostname must belong to an allow-listed platform domain (no IP literals)
* every address the hostname resolves to must be publicly routable (SSRF)
* control characters / whitespace / overlong URLs rejected
* tracking parameters and fragments are removed
"""

from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .errors import JobError
from .platforms import Platform, detect_platform

MAX_URL_LENGTH = 2048

_TRACKING_PARAMS = {
    "si", "igsh", "igshid", "fbclid", "gclid", "mibextid", "feature", "pp",
    "is_from_webapp", "sender_device", "sender_web_id", "_r", "_t", "ref", "ref_src", "s",
}


@dataclass(frozen=True)
class ValidatedUrl:
    url: str
    host: str
    platform: Platform


def _is_public_ip(addr: str) -> bool:
    ip = ipaddress.ip_address(addr.split("%", 1)[0])
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not (ip.is_multicast or ip.is_reserved or ip.is_loopback or ip.is_link_local)


def resolve_public(host: str) -> None:
    """Raise unless `host` resolves only to public addresses."""
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError) as exc:
        raise JobError("invalid_url", "That website couldn't be found.") from exc
    addrs = {info[4][0] for info in infos}
    if not addrs or not all(_is_public_ip(a) for a in addrs):
        raise JobError("invalid_url", "That address isn't allowed.")


def validate_url(
    raw: str,
    *,
    allow_http: bool = False,
    enable_other: bool = True,
    extra_domains: list[str] | None = None,
    resolve: bool = True,
) -> ValidatedUrl:
    if not isinstance(raw, str):
        raise JobError("invalid_url")
    raw = raw.strip()
    if not raw or len(raw) > MAX_URL_LENGTH:
        raise JobError("invalid_url")
    if any(ord(c) < 0x21 or ord(c) == 0x7F for c in raw):
        raise JobError("invalid_url")
    if "://" not in raw and not raw.startswith("//"):
        raw = "https://" + raw  # accept "tiktok.com/@x/video/1" pasted without a scheme

    try:
        parts = urlsplit(raw)
        port = parts.port
    except ValueError as exc:
        raise JobError("invalid_url") from exc

    scheme = parts.scheme.lower()
    if scheme not in ({"https", "http"} if allow_http else {"https"}):
        raise JobError("invalid_url", "Only https:// links are supported.")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise JobError("invalid_url")
    if port is not None and port not in (443, 80):
        raise JobError("invalid_url")

    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        raise JobError("invalid_url")
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise JobError("invalid_url") from exc
    try:
        ipaddress.ip_address(host)
        raise JobError("unsupported_url")  # IP literals are never a supported platform
    except ValueError:
        pass

    path = parts.path or "/"
    platform = detect_platform(host, path, enable_other, extra_domains or [])
    if platform is None:
        raise JobError("unsupported_url")

    query = urlencode(
        [
            (k, v)
            for k, v in parse_qsl(parts.query, keep_blank_values=True)
            if k.lower() not in _TRACKING_PARAMS and not k.lower().startswith("utm_")
        ]
    )
    normalized = urlunsplit((scheme, host, path, query, ""))

    if resolve:
        resolve_public(host)
    return ValidatedUrl(url=normalized, host=host, platform=platform)
