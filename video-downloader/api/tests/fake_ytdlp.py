"""Stand-in for yt-dlp used by the offline pipeline tests (YTDLP_COMMAND="python tests/fake_ytdlp.py").

Behaviour is controlled by env vars:
  FAKE_YTDLP_MODE    ok | private | generic | live | huge
  FAKE_YTDLP_SOURCE  media file to "download"
"""

import json
import os
import shutil
import sys

args = sys.argv[1:]
mode = os.environ.get("FAKE_YTDLP_MODE", "ok")

# The real pipeline must always pass these hardening flags.
for required in ("--ignore-config", "--no-playlist"):
    if required not in args:
        print(f"ERROR: missing {required}", file=sys.stderr)
        sys.exit(2)
if args[args.index("--use-extractors") + 1] != "default,-generic":
    print("ERROR: generic extractor not disabled", file=sys.stderr)
    sys.exit(2)

if "--dump-single-json" in args:
    if mode == "private":
        print("ERROR: [TikTok] 1: This account is private", file=sys.stderr)
        sys.exit(1)
    info = {
        "id": "1",
        "title": "creator-name funny video",
        "uploader": "@creator",
        "extractor_key": "Generic" if mode == "generic" else "TikTok",
        "duration": 2,
        "is_live": mode == "live",
        "requested_formats": [
            {"format_id": "v", "filesize": 10**12 if mode == "huge" else 50_000, "vcodec": "h264"},
            {"format_id": "a", "filesize": 10_000, "vcodec": "none"},
        ],
    }
    print(json.dumps(info))
    sys.exit(0)

if "--load-info-json" in args:
    out_dir = args[args.index("--paths") + 1]
    for pct in (25, 50, 100):
        print(f"[vdl-progress] {pct * 600} 60000 NA v", flush=True)
    shutil.copy(os.environ["FAKE_YTDLP_SOURCE"], os.path.join(out_dir, "source.mkv"))
    sys.exit(0)

print("ERROR: unexpected invocation", file=sys.stderr)
sys.exit(2)
