"""Standalone media worker: `python -m app.worker_main`.

Runs job processing + periodic cleanup without serving HTTP. Point it at the same DATABASE_URL
and storage as the API (and set RUN_EMBEDDED_WORKER=false on the API) to scale media
processing separately from the web tier.
"""

from __future__ import annotations

import logging
import signal
import threading

from .config import get_settings
from .db import init_engine
from .jobs.runner import Worker
from .storage import get_storage


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = get_settings()
    settings.validate_for_runtime()
    init_engine(settings.database_url)
    worker = Worker(settings, get_storage())
    worker.start()

    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    stop.wait()
    logging.info("shutting down worker")
    worker.stop(timeout=30)


if __name__ == "__main__":
    main()
