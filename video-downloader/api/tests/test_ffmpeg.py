import json
import subprocess

import pytest

from app.config import Settings
from app.errors import JobError
from app.media import ffmpeg

from .conftest import needs_ffmpeg

pytestmark = needs_ffmpeg

IDENTIFYING = ("creator", "tiktok", "funny", "Lavf", "Lavc", "2024-01-01")


def _all_tags(path) -> str:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    data = json.loads(out)
    tags = [data["format"].get("tags", {})] + [s.get("tags", {}) for s in data["streams"]]
    return json.dumps(tags) + json.dumps(data.get("chapters", []))


def _export(src, tmp_path, **overrides):
    s = Settings(environment="test", **overrides)
    dst = tmp_path / "out.mp4"
    plan, info = ffmpeg.export_mp4(src, dst, s, timeout=120)
    return plan, info, dst


def test_h264_is_stream_copied_and_metadata_stripped(sample_videos, tmp_path):
    plan, info, dst = _export(sample_videos["h264_aac"], tmp_path)
    assert plan.copy_video and plan.copy_audio
    assert (info.width, info.height) == (320, 240)
    assert info.video["r_frame_rate"] == "25/1"
    tags = _all_tags(dst)
    for needle in IDENTIFYING:
        assert needle not in tags
    raw = dst.read_bytes()
    for needle in (b"creator", b"tiktok", b"Lavf"):
        assert needle not in raw


def test_vp9_kept_in_modern_mode_and_audio_made_aac(sample_videos, tmp_path):
    plan, info, dst = _export(sample_videos["vp9_opus"], tmp_path)
    assert plan.copy_video and not plan.copy_audio
    assert info.video["codec_name"] == "vp9"
    assert info.audio["codec_name"] == "aac"
    assert "creator" not in _all_tags(dst)


def test_vp9_reencoded_to_h264_in_h264_mode(sample_videos, tmp_path):
    plan, info, dst = _export(sample_videos["vp9_opus"], tmp_path, video_compat="h264")
    assert not plan.copy_video
    assert info.video["codec_name"] == "h264"
    assert info.video["pix_fmt"] == "yuv420p"
    assert (info.width, info.height) == (320, 240)
    assert "Lavc" not in _all_tags(dst)
    assert b"Lavc" not in dst.read_bytes() and b"x264 - core" not in dst.read_bytes()


def test_incompatible_codec_is_converted(sample_videos, tmp_path):
    plan, info, _ = _export(sample_videos["mpeg4_mp3"], tmp_path)
    assert not plan.copy_video and plan.copy_audio
    assert info.video["codec_name"] == "h264" and info.audio["codec_name"] == "mp3"


def test_output_validation_rejects_non_mp4(tmp_path):
    bogus = tmp_path / "x.mp4"
    bogus.write_bytes(b"<html>not a video</html>")
    with pytest.raises(JobError):
        ffmpeg.validate_output(bogus, Settings(environment="test"))


def test_output_validation_enforces_size(sample_videos, tmp_path):
    _, _, dst = _export(sample_videos["h264_aac"], tmp_path)
    s = Settings(environment="test", max_file_size_mb=0)
    with pytest.raises(JobError) as exc:
        ffmpeg.validate_output(dst, s)
    assert exc.value.code == "too_large"
