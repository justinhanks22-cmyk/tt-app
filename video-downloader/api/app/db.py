"""Database engine, session factory and schema bootstrap (SQLite in dev, Postgres in prod)."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


class Base(DeclarativeBase):
    pass


_engine: Engine | None = None
_session_factory: sessionmaker[Session] | None = None


def _normalize_url(url: str) -> str:
    # Accept the common "postgres://" / "postgresql://" forms and use the psycopg 3 driver.
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://") :]
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://") :]
    return url


def init_engine(database_url: str) -> Engine:
    global _engine, _session_factory
    url = _normalize_url(database_url)
    if url.startswith("sqlite"):
        path = url.split("///", 1)[-1]
        if path and path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        engine = create_engine(url, connect_args={"check_same_thread": False, "timeout": 30})

        @event.listens_for(engine, "connect")
        def _sqlite_pragmas(dbapi_conn, _):  # pragma: no cover - trivial
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")  # lets the API read while the worker writes
            cur.execute("PRAGMA busy_timeout=30000")
            cur.close()
    else:
        engine = create_engine(url, pool_pre_ping=True, pool_size=10, max_overflow=10)

    from . import models  # noqa: F401  (register tables)

    Base.metadata.create_all(engine)
    _engine = engine
    _session_factory = sessionmaker(engine, expire_on_commit=False)
    return engine


def get_engine() -> Engine:
    assert _engine is not None, "init_engine() has not been called"
    return _engine


@contextmanager
def session_scope() -> Iterator[Session]:
    assert _session_factory is not None, "init_engine() has not been called"
    session = _session_factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
