# First Paycheck developer commands. `make help` lists them.
# Targets that touch web/ skip cleanly when web/ is absent.

SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

PYTEST_DEFAULT_MARKS := not plaid_sandbox and not llm_live
EVAL_MAX_COST_CENTS ?= 200

# Run a command in web/ when it exists; say so otherwise. A failing command
# still fails the target.
define in_web
	if [ -d web ]; then $(1); else echo "web/ not found, skipped: $(1)"; fi
endef

.PHONY: help
help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

.PHONY: setup
setup: ## Install Python and web dependencies and the git hooks
	uv sync --all-packages --locked
	uv run pre-commit install
	@$(call in_web,pnpm --dir web install --frozen-lockfile)

.PHONY: dev
dev: ## Run api, worker and web together (honcho, Procfile.dev)
	./scripts/dev.sh

.PHONY: test
test: ## All Python tests (api, evals, scripts) and web unit tests
	uv run pytest -m "$(PYTEST_DEFAULT_MARKS)"
	@$(call in_web,pnpm --dir web test)

.PHONY: test-api
test-api: ## API tests only
	uv run pytest api/tests -m "$(PYTEST_DEFAULT_MARKS)"

.PHONY: lint
lint: ## ruff, ruff format, mypy, the em-dash check, eslint and tsc
	uv run ruff check .
	uv run ruff format --check .
	uv run mypy
	uv run python scripts/check_no_em_dash.py
	@$(call in_web,pnpm --dir web lint)
	@$(call in_web,pnpm --dir web typecheck)

.PHONY: eval
eval: ## Free (deterministic) eval suites
	uv run python -m evals.run --suite free --max-cost-cents 0

.PHONY: eval-llm
eval-llm: ## LLM eval suites, capped at EVAL_MAX_COST_CENTS
	uv run python -m evals.run --suite llm --max-cost-cents $(EVAL_MAX_COST_CENTS)

.PHONY: migrate
migrate: ## alembic upgrade head (DATABASE_URL_PRIVILEGED)
	cd api && uv run alembic upgrade head

.PHONY: revision
revision: ## New migration: make revision id=0002_core msg="core tables"
	@if [ -z "$(id)" ] || [ -z "$(msg)" ]; then \
		echo 'usage: make revision id=0002_core msg="core tables"'; exit 2; fi
	cd api && uv run alembic revision --autogenerate --rev-id "$(id)" -m "$(msg)"

.PHONY: seed
seed: ## Load reference data (idempotent)
	cd api && uv run python -m db.seed.load

.PHONY: types
types: ## Export api/openapi.json and regenerate the web client types
	cd api && uv run python -m app.openapi > openapi.json.tmp && mv openapi.json.tmp openapi.json
	@$(call in_web,pnpm --dir web gen:api)

.PHONY: worker
worker: ## Run the background worker
	cd api && uv run python -m jobs.worker
