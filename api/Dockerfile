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

# tesseract for OCR, pinned to the exact Debian package: redaction finds what
# OCR reads, so a tesseract upgrade is a deliberate change made here (and the
# ingest tests below rerun against it). pango, harfbuzz and a font for
# WeasyPrint PDF export.
ARG TESSERACT_VERSION=5.3.0-2
ARG TESSDATA_ENG_VERSION=1:4.1.0-2
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tesseract-ocr=${TESSERACT_VERSION} \
      libtesseract5=${TESSERACT_VERSION} \
      tesseract-ocr-eng=${TESSDATA_ENG_VERSION} \
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
# Adds the api dev group and runs the ingest and plan export tests (unit and
# integration) against the image's own tesseract and pango builds. The integration tests need a
# Postgres: pass TEST_DATABASE_URL, for example
#
#   docker run --rm --network host \
#     -e TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/first_paycheck_test \
#     first-paycheck-test
#
# CI=true makes a missing tesseract or database a failure instead of a skip.
FROM base AS test
RUN uv sync --frozen --package first-paycheck-api --no-install-workspace
COPY api/ api/
RUN uv sync --frozen --package first-paycheck-api
WORKDIR /app/api
USER app
ENV CI=true
CMD ["pytest", "-p", "no:cacheprovider", "tests/unit/ingest", "tests/integration/ingest", "tests/unit/export", "tests/integration/export"]


# ---------------------------------------------------------------- runtime
FROM base AS runtime
COPY api/ api/
RUN uv sync --frozen --no-dev --package first-paycheck-api \
 && rm -rf /app/api/tests
WORKDIR /app/api
USER app
EXPOSE 8000
# What Render runs (render.yaml): the API on $PORT and the job worker, supervised
# by app.serve. `python -m app.serve api` runs the API alone.
CMD ["python", "-m", "app.serve"]
