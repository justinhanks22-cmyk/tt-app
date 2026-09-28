"""S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO...)."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path

from starlette.responses import RedirectResponse, Response

from ..config import Settings
from ..util import utcnow
from .base import Storage, check_key


class S3Storage(Storage):
    def __init__(self, settings: Settings):
        import boto3
        from botocore.config import Config

        self.bucket = settings.s3_bucket
        self.prefix = settings.s3_prefix
        self.presign_seconds = settings.s3_presign_seconds
        self.client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint_url or None,
            region_name=settings.s3_region or None,
            aws_access_key_id=settings.s3_access_key_id or None,
            aws_secret_access_key=settings.s3_secret_access_key or None,
            config=Config(signature_version="s3v4", retries={"max_attempts": 5, "mode": "standard"}),
        )

    def key_for(self, file_id: str) -> str:
        return check_key(f"{self.prefix}{file_id}.mp4")

    def put(self, local_path: Path, key: str) -> None:
        self.client.upload_file(
            str(local_path),
            self.bucket,
            check_key(key),
            ExtraArgs={"ContentType": "video/mp4", "CacheControl": "private, no-store"},
        )
        local_path.unlink(missing_ok=True)

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=check_key(key))  # idempotent in S3

    def exists(self, key: str) -> bool:
        from botocore.exceptions import ClientError

        try:
            self.client.head_object(Bucket=self.bucket, Key=check_key(key))
            return True
        except ClientError:
            return False

    def download_response(self, key: str, filename: str, expires_at: datetime, head: bool = False) -> Response:
        # Short-lived presigned URL; never longer than the file's own remaining lifetime.
        remaining = int((expires_at - utcnow()).total_seconds())
        url = self.client.generate_presigned_url(
            "head_object" if head else "get_object",
            Params={
                "Bucket": self.bucket,
                "Key": check_key(key),
                **({} if head else {"ResponseContentDisposition": f'attachment; filename="{filename}"',
                                    "ResponseContentType": "video/mp4"}),
            },
            ExpiresIn=max(1, min(self.presign_seconds, remaining)),
        )
        return RedirectResponse(url, status_code=302, headers={"Cache-Control": "no-store"})

    def iter_objects(self) -> Iterator[tuple[str, datetime]]:
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=self.prefix):
            for obj in page.get("Contents", []):
                modified = obj["LastModified"].astimezone(timezone.utc).replace(tzinfo=None)
                yield obj["Key"], modified
