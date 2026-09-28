"""Tiny self-contained HTML pages for download links opened directly in a browser."""

from __future__ import annotations

from html import escape

from starlette.responses import HTMLResponse

_TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>{title}</title>
<style>
:root{{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#111827;--muted:#6b7280;--accent:#4f46e5}}
@media (prefers-color-scheme:dark){{:root{{--bg:#0b0d12;--card:#151922;--fg:#f3f4f6;--muted:#9ca3af;--accent:#818cf8}}}}
body{{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px;box-sizing:border-box}}
.card{{background:var(--card);border-radius:16px;padding:32px;max-width:420px;text-align:center;
box-shadow:0 1px 3px rgba(0,0,0,.08)}}
h1{{font-size:20px;margin:0 0 8px}} p{{color:var(--muted);margin:0 0 20px}}
a{{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:600}}
</style></head>
<body><main class="card"><h1>{title}</h1><p>{body}</p><a href="/">Download another video</a></main></body></html>"""


def message_page(title: str, body: str, status_code: int) -> HTMLResponse:
    return HTMLResponse(
        _TEMPLATE.format(title=escape(title), body=escape(body)),
        status_code=status_code,
        headers={"Cache-Control": "no-store"},
    )


def expired_page() -> HTMLResponse:
    return message_page(
        "This download has expired",
        "Videos are automatically and permanently deleted 24 hours after they're processed. "
        "Paste the link again to create a new download.",
        410,
    )


def not_found_page() -> HTMLResponse:
    return message_page("Download not found", "This download link is invalid.", 404)
