"""Rate limiting.

* General request limiter: in-memory sliding window per client (cheap; per API instance).
* Job-creation limits are enforced from the database in routes.py, so they hold across
  multiple API instances and restarts.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque


class SlidingWindowLimiter:
    def __init__(self, limit: int, window_seconds: float):
        self.limit = limit
        self.window = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()
        self._last_prune = time.monotonic()

    def hit(self, key: str) -> float | None:
        """Record a request. Returns None if allowed, else seconds until a slot frees up."""
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and q[0] <= now - self.window:
                q.popleft()
            if len(q) >= self.limit:
                return max(0.0, q[0] + self.window - now)
            q.append(now)
            if now - self._last_prune > 300:
                self._prune(now)
            return None

    def _prune(self, now: float) -> None:
        for key in [k for k, q in self._hits.items() if not q or q[-1] <= now - self.window]:
            del self._hits[key]
        self._last_prune = now
