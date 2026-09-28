"""FastAPI application. Optionally runs the job worker in-process (RUN_EMBEDDED_WORKER=true)."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .api.routes import router
from .config import Settings, get_settings
from .db import init_engine
from .storage import get_storage


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
        settings.validate_for_runtime()
        init_engine(settings.database_url)
        app.state.worker = None
        if settings.run_embedded_worker:
            from .jobs.runner import Worker

            app.state.worker = Worker(settings, get_storage())
            app.state.worker.start()
        yield
        if app.state.worker is not None:
            app.state.worker.stop()

    app = FastAPI(title="Video Downloader API", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.include_router(router)

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException):
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "error", "message": str(exc.detail)}
        return JSONResponse({"error": detail}, status_code=exc.status_code, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, __: RequestValidationError):
        return JSONResponse(
            {"error": {"code": "invalid_url", "message": "Please paste a valid video link."}}, status_code=400
        )

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Frame-Options", "DENY")
        return response

    return app


app = create_app()
