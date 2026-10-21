# syntax=docker/dockerfile:1
#
# One image for the API and the worker. Build from the repo root, because the
# uv workspace (pyproject.toml, uv.lock) lives there:
#
#   docker build -f api/Dockerfile -t first-paycheck-api .                 # runtime
#   docker build -f api/Dockerfile --target test -t first-paycheck-test .  # CI ingest tests
#
# The Debian release is pinned (bookworm) so tesseract and pango versions only
# change when this file does; OCR output differs between versions.

FROM python:3.12-slim-bookworm AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH=/opt/venv/bin:$PATH

# tesseract for OCR; pango, harfbuzz and a font for WeasyPrint PDF export.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tesseract-ocr \
      tesseract-ocr-eng \
      libpango-1.0-0 \
      libpangoft2-1.0-0 \
      libharfbuzz0b \
      libharfbuzz-subset0 \
      fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.12.3 /uv /uvx /bin/

RUN groupadd --system app \
 && useradd --system --gid app --home-dir /app --no-create-home --shell /usr/sbin/nologin app

WORKDIR /app

# Dependencies first, so code changes do not reinstall them.
COPY pyproject.toml uv.lock ./
COPY api/pyproject.toml api/pyproject.toml
COPY evals/pyproject.toml evals/pyproject.toml
RUN uv sync --frozen --no-dev --package first-paycheck-api --no-install-workspace


# ---------------------------------------------------------------- test
# Adds the api dev group and runs the ingest tests, which depend on the
# image's tesseract build. Exit code 5 (no tests collected) counts as a pass
# until the ingest tests exist.
FROM base AS test
RUN uv sync --frozen --package first-paycheck-api --no-install-workspace
COPY api/ api/
RUN uv sync --frozen --package first-paycheck-api
WORKDIR /app/api
USER app
CMD ["sh", "-c", "pytest -p no:cacheprovider tests/unit/ingest; rc=$?; if [ \"$rc\" -eq 5 ]; then echo 'no ingest tests collected yet'; exit 0; fi; exit \"$rc\""]


# ---------------------------------------------------------------- runtime
FROM base AS runtime
COPY api/ api/
RUN uv sync --frozen --no-dev --package first-paycheck-api \
 && rm -rf /app/api/tests
WORKDIR /app/api
USER app
EXPOSE 8000
# Render sets PORT. The worker service overrides this with `python -m jobs.worker`.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port \"${PORT:-8000}\" --workers 2 --proxy-headers --forwarded-allow-ips '*'"]
