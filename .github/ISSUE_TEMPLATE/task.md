---
name: Task
about: A unit of planned work from the backlog
title: ""
labels: []
assignees: []
---

## Goal

What changes for the user or the codebase when this is done.

## Spec

Link to `docs/specs/NNN-slug.md`, or "n/a" for infrastructure work.

## Tests first

The failing tests that define done (unit, integration, RLS, web, e2e).

## Done when

- [ ] Tests written first and passing
- [ ] `make lint` and `make test` pass; CI green
- [ ] `make types` run and committed if the API changed
- [ ] Spec, `CLAUDE.md` files and `docs/ai-log.md` updated where relevant

## Notes

Dependencies, risks, links.
