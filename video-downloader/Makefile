.PHONY: install dev-api dev-worker dev-web test build up down cleanup

install:            ## install API (Python) and web (Node) dependencies
	cd api && python3 -m pip install -r requirements-dev.txt
	cd web && npm ci

dev-api:            ## FastAPI + embedded worker on :8000 (SQLite + local files)
	cd api && uvicorn app.main:app --reload --port 8000

dev-worker:         ## optional separate worker (set RUN_EMBEDDED_WORKER=false for dev-api)
	cd api && python3 -m app.worker_main

dev-web:            ## Next.js on :3000, proxying /api to :8000
	cd web && npm run dev

test:               ## backend tests + frontend type check and build
	cd api && python3 -m pytest
	cd web && npm run typecheck && npm run build

cleanup:            ## run one cleanup pass now
	cd api && python3 -m app.cleanup

up:                 ## production-style stack (Caddy, web, api, worker, Postgres)
	docker compose up -d --build

down:
	docker compose down
