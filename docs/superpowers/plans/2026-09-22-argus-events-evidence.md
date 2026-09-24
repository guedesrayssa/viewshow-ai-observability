# ARGUS Events and Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform every eligible ARGUS canonical record into a searchable public Event and create Evidence only through an explicit, reproducible incident-correlation rule.

**Architecture:** The ingestion application owns a pure canonical-to-event projector and a separate event-to-incident correlator. It materializes deterministic event, incident-link, and evidence items under the candidate dataset version before activation. The API reads only the active version, exposes a signed-cursor global feed and incident-scoped views, and the frontend renders real data without default fake filters or production fixtures.

**Tech Stack:** Python 3.12, pytest, boto3/DynamoDB, TypeScript, Fastify, Vitest, React 19, Next.js 16, Playwright-compatible E2E.

**Spec:** `docs/superpowers/specs/2026-09-22-argus-events-evidence-design.md`

## Global Constraints

- Work only in `.worktrees/argus-events-evidence` until the implementation commits are ready.
- Use RED-GREEN-REFACTOR for each behavior; record the focused failing and passing command.
- Do not use fixtures or seeds as a production data source.
- Preserve unrelated local changes and never use `git stash`.
- Do not run `terraform destroy`.
- If AWS validation is needed, use only `--profile default --region us-east-1`.
- Integrate commits into the clean original checkout before any Terraform update; this plan does not require a Terraform update.
- Keep Event creation independent from correlation. A time-window match by itself must never create Evidence.

## Review Focus

- No eligible `signal_bucket`, `live_event`, or `live_event_sde` record disappears because it lacks an incident or timestamp.
- Event IDs, Evidence IDs, ordering, and cursor continuation are deterministic.
- Every Evidence contains a persisted accepted correlation with incident, event, rule version, matched fields, and time distance.
- Dataset activation cannot expose mixed candidate/active projection data.
- Public payloads preserve lineage and never invent timestamps or measurements.

---

### Task 1: Add the pure Event projector

**Files:**

- Create: `apps/backend/ingestion-data/application/projections/events.py`
- Create: `apps/backend/ingestion-data/tests/unit/application/test_event_projection.py`
- Modify: `apps/backend/ingestion-data/application/projections/__init__.py`

**Step 1: Write failing projector tests**

Add literal-input tests covering:

- `signal_bucket` maps to category `signal_observation`;
- `live_event` maps to category `live_event`;
- `live_event_sde` maps to category `live_event_context`;
- the ID is stable across dataset versions and changes when the natural key changes;
- dimensions and measures are preserved exactly;
- a missing `observed_at` remains `occurred_at=None`, adds `MISSING_EVENT_TIMESTAMP`, and uses `updated_at` only as `sort_at`;
- all three sources expose source system, source dataset, source record ID, canonical raw locator, and raw availability.

Run:

```bash
cd apps/backend/ingestion-data
.venv/bin/pytest tests/unit/application/test_event_projection.py -q
```

Expected: FAIL because the projector does not exist.

**Step 2: Implement the smallest pure projector**

Define frozen value objects `ProjectedEvent`, `RawAvailability`, and `EventQuality`. Implement:

```python
def project_event(record: CanonicalRecord, *, dataset_version: str) -> ProjectedEvent | None:
    ...
```

Return `None` only for canonical record types outside the three eligible source datasets. Derive the public ID from the source system, source dataset, and canonical natural key using the versioned `event:v1` namespace. Copy dimensions and measures rather than filtering them.

**Step 3: Run focused tests and refactor**

Run the command from Step 1. Expected: PASS.

Run:

```bash
.venv/bin/ruff check application/projections/events.py tests/unit/application/test_event_projection.py
.venv/bin/mypy application/projections/events.py
```

**Step 4: Commit**

```bash
git add apps/backend/ingestion-data/application/projections/events.py \
  apps/backend/ingestion-data/application/projections/__init__.py \
  apps/backend/ingestion-data/tests/unit/application/test_event_projection.py
git commit -m "feat(ingestion): project canonical ARGUS events"
```

### Task 2: Add the explicit correlator and Evidence model

**Files:**

- Create: `apps/backend/ingestion-data/application/projections/event_correlation.py`
- Create: `apps/backend/ingestion-data/tests/unit/application/test_event_correlation.py`
- Modify: `apps/backend/ingestion-data/bootstrap/config.py`
- Modify: `apps/backend/ingestion-data/tests/unit/bootstrap/test_config.py`

**Step 1: Write failing rule tests**

Cover these observable cases with hand-derived expectations:

- exact normalized semantic match inside the window creates one link and one Evidence;
- a bounded component token in `source` or `entity` creates Evidence, while partial words and
  short tokens are rejected;
- one matching field is `moderate`, two are `strong`;
- exactly five hours before and after is accepted;
- one second beyond either boundary is rejected;
- a time match without a semantic match is rejected;
- a semantic match without an event timestamp is rejected;
- empty strings never match;
- Evidence ID remains stable for the same event, incident, and rule version;
- correlation records the matched field pairs and signed time distance;
- configuration defaults to 18,000 seconds and rejects zero, negative, non-integer, or greater values.

Run:

```bash
cd apps/backend/ingestion-data
.venv/bin/pytest tests/unit/application/test_event_correlation.py tests/unit/bootstrap/test_config.py -q
```

Expected: FAIL on missing correlation behavior and configuration.

**Step 2: Implement `argus-explicit-v2`**

Add frozen `IncidentCorrelationInput`, `EventIncidentLink`, and `ProjectedEvidence` values.
Normalize comparison values using Unicode casefold and trimmed whitespace. Require timestamp plus
at least one exact semantic match, or a four-character bounded component token from the Incident
inside a technical `source`/`entity` identifier. Clamp configuration through validation, not silent
coercion.

**Step 3: Run focused tests**

Run the Step 1 command. Expected: PASS.

**Step 4: Commit**

```bash
git add apps/backend/ingestion-data/application/projections/event_correlation.py \
  apps/backend/ingestion-data/tests/unit/application/test_event_correlation.py \
  apps/backend/ingestion-data/bootstrap/config.py \
  apps/backend/ingestion-data/tests/unit/bootstrap/test_config.py
git commit -m "feat(ingestion): correlate events with incidents explicitly"
```

### Task 3: Materialize and reconcile Event projections

**Files:**

- Modify: `apps/backend/ingestion-data/domain/models.py`
- Modify: `apps/backend/ingestion-data/ports/storage.py`
- Modify: `apps/backend/ingestion-data/application/rebuild_projections.py`
- Modify: `apps/backend/ingestion-data/application/backfill.py`
- Modify: `apps/backend/ingestion-data/adapters/dynamodb/projections.py`
- Modify: `apps/backend/ingestion-data/bootstrap/container.py`
- Create: `apps/backend/ingestion-data/tests/integration/test_canonical_event_projections.py`
- Modify: `apps/backend/ingestion-data/tests/unit/adapters/test_dynamodb_projections.py`
- Modify: `apps/backend/ingestion-data/tests/integration/test_canonical_projection_rebuild.py`
- Modify: `apps/backend/ingestion-data/tests/resilience/test_activation_boundaries.py`

**Step 1: Write failing materialization tests**

Using the real projection service and the repository fake/local Dynamo boundary, prove that:

- every eligible canonical record creates one global Event item;
- linked Events additionally create incident Event and Evidence items;
- unlinked and timestamp-less Events remain in the global count;
- repeated materialization is idempotent;
- same identity with divergent content fails reconciliation;
- projection items remain under the candidate dataset until activation;
- projection metadata includes archives, watermarks, formula/rule versions, revision, coverage, quality flags, and source lineage;
- adjacent day records can correlate across midnight within five hours;
- recorded eligible/projected/unlinked/linked/evidence counts reconcile.

Run:

```bash
cd apps/backend/ingestion-data
.venv/bin/pytest tests/integration/test_canonical_event_projections.py \
  tests/integration/test_canonical_projection_rebuild.py \
  tests/resilience/test_activation_boundaries.py -q
```

Expected: FAIL because Event projections are not materialized.

**Step 2: Add projection storage values and port**

Represent global Event items, Event lookup items, incident links, Evidences, and a projection summary. Keep batch writes retry-safe and deterministic. Use keys documented by the design and an Event lookup key for constant-time detail reads.

**Step 3: Integrate materialization before activation**

Collect Events and Incidents for the candidate canonical set, correlate after both sides are available, persist all outputs, verify counts, then allow activation. For scoped rebuilds, include the adjacent time range required by the configured window so midnight correlations are reproducible.

**Step 4: Run focused and ingestion suites**

```bash
cd apps/backend/ingestion-data
.venv/bin/pytest tests/unit/application/test_event_projection.py \
  tests/unit/application/test_event_correlation.py \
  tests/unit/adapters/test_dynamodb_projections.py \
  tests/integration/test_canonical_event_projections.py \
  tests/integration/test_canonical_projection_rebuild.py \
  tests/resilience/test_activation_boundaries.py -q
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/backend/ingestion-data
git commit -m "feat(ingestion): materialize event and evidence projections"
```

### Task 4: Publish closed contracts and OpenAPI routes

**Files:**

- Modify: `apps/backend/api/contracts/src/index.ts`
- Modify: `apps/backend/api/contracts/openapi/public.openapi.json`
- Modify: `apps/backend/api/contracts/README.md`
- Modify: `apps/backend/api/tests/contracts.test.ts`
- Modify: `apps/backend/ingestion-data/tests/contracts/test_projection_payloads.py`

**Step 1: Write failing contract tests**

Assert closed schemas for Event, EventCorrelation, Evidence, RawAvailability, EventQuality, facets, pagination, and traceability. Assert routes and supported query values for:

- `GET /api/v1/events`;
- `GET /api/v1/events/{eventId}`;
- `GET /api/v1/incidents/{incidentId}/events`;
- `GET /api/v1/incidents/{incidentId}/events/{eventId}`;
- diagnosis Evidence output.

Run:

```bash
cd apps/backend/api
npm test -- --run tests/contracts.test.ts
```

Expected: FAIL on the new public shapes and routes.

**Step 2: Define runtime schemas and inferred types**

Replace `unknown[]` Event/Evidence payloads with strict schemas. Keep nullable timestamps explicit and dimensions/measures as JSON value maps. Expose `sourceDataset`, `sourceRecordId`, `datasetVersion`, raw status, quality, freshness, and correlation status.

**Step 3: Update OpenAPI and projection contract test**

Ensure OpenAPI query constraints match runtime parsing exactly, including `limit` 1–100 and `correlation=all|linked|unlinked`.

**Step 4: Run contract builds/tests**

```bash
cd apps/backend/api
npm run build
npm test -- --run tests/contracts.test.ts
cd ../ingestion-data
.venv/bin/pytest tests/contracts/test_projection_payloads.py -q
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/backend/api/contracts apps/backend/api/tests/contracts.test.ts \
  apps/backend/ingestion-data/tests/contracts/test_projection_payloads.py
git commit -m "feat(contracts): publish event and evidence resources"
```

### Task 5: Implement active-dataset Event and Evidence API reads

**Files:**

- Modify: `apps/backend/api/src/modules/incidents/domain/cursor.ts`
- Modify: `apps/backend/api/src/modules/incidents/domain/incident.ts`
- Modify: `apps/backend/api/src/modules/incidents/ports/incident-repository.ts`
- Modify: `apps/backend/api/src/modules/incidents/adapters/dynamodb-incident-repository.ts`
- Modify: `apps/backend/api/src/modules/incidents/application/incident-use-cases.ts`
- Modify: `apps/backend/api/src/modules/incidents/index.ts`
- Modify: `apps/backend/api/src/http/public-routes.ts`
- Modify: `apps/backend/api/src/app.ts`
- Modify: `apps/backend/api/tests/incident-use-cases.test.ts`
- Modify: `apps/backend/api/tests/dynamodb-adapters.test.ts`
- Modify: `apps/backend/api/tests/gateway-http.integration.test.ts`
- Modify: `apps/backend/api/tests/live-api.e2e.test.ts`

**Step 1: Write failing repository and use-case tests**

Prove:

- global feed reads daily partitions in requested order and continues between days;
- `all`, `linked`, and `unlinked` never drop eligible Events incorrectly;
- search/category/source filters and facets use real fields;
- cursor is bound to dataset version, normalized filters, sort, and last key;
- a cursor from another query or active dataset is rejected;
- incident Events contain only persisted links;
- Event detail comes from deterministic lookup and incident detail verifies the link;
- diagnosis returns persisted Evidences even with no hypotheses;
- missing resources return 404 and missing projection returns 503;
- partial projection returns 200 with freshness, warnings, and `meta.partial=true`.

Run:

```bash
cd apps/backend/api
npm test -- --run tests/incident-use-cases.test.ts tests/dynamodb-adapters.test.ts
```

Expected: FAIL because current Event/Evidence methods return `DATA_UNAVAILABLE`.

**Step 2: Implement repository queries and cursor continuation**

Read only the resolved active dataset version. Query incident partitions directly and global daily partitions with bounded continuation. Build facets from the matched read window and return a signed opaque cursor without exposing physical keys.

**Step 3: Implement routes and response quality**

Parse against the shared contracts, map repository state to documented errors, and compute `observedThrough`/`lagSeconds` without replacing absent source values.

**Step 4: Run API tests**

```bash
cd apps/backend/api
npm test -- --run tests/incident-use-cases.test.ts \
  tests/dynamodb-adapters.test.ts \
  tests/gateway-http.integration.test.ts \
  tests/live-api.e2e.test.ts
npm run typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/backend/api/src apps/backend/api/tests
git commit -m "feat(api): serve global events and incident evidence"
```

### Task 6: Render the real global and incident experiences

**Files:**

- Read: `apps/frontend/AGENTS.md` and its required Next.js documentation
- Modify: `apps/frontend/lib/data/endpoints.ts`
- Modify: `apps/frontend/app/(painel)/eventos/events-data.ts`
- Modify: `apps/frontend/app/(painel)/eventos/events-resource.ts`
- Modify: `apps/frontend/app/(painel)/eventos/events-view.tsx`
- Modify: `apps/frontend/app/(painel)/eventos/events-table.tsx`
- Modify: `apps/frontend/app/(painel)/eventos/events-chart.tsx`
- Modify: `apps/frontend/app/(painel)/evidencias/evidence-data.ts`
- Modify: `apps/frontend/app/(painel)/evidencias/evidence-resource.ts`
- Modify: `apps/frontend/app/(painel)/evidencias/evidence-view.tsx`
- Create: `apps/frontend/app/(painel)/eventos/events-view.test.tsx`
- Create: `apps/frontend/app/(painel)/evidencias/evidence-view.test.tsx`
- Modify: `apps/frontend/tests/resources.test.ts`
- Modify: `apps/frontend/docs/camada-de-dados.md`

**Step 1: Read the repository-required Next.js 16 documentation**

Read `apps/frontend/AGENTS.md`, then read every referenced Next.js document relevant to App Router pages, client components, URL search parameters, and data fetching before editing frontend code.

**Step 2: Write failing component/resource tests**

Cover:

- `/eventos` without an incident requests the global endpoint and renders real Events;
- no fake device, region, version, or source filter is sent initially;
- the visible correlation filter switches between all/linked/unlinked;
- “carregar mais” appends the next cursor page without losing prior rows;
- incident mode calls the incident route and labels the context;
- quality, freshness, source, source-record ID, raw availability, and unlinked status are visible;
- Evidence renders without a hypothesis and links to its source Event;
- unavailable/partial states are explicit;
- example data remains disabled in production regardless of environment text.

Run:

```bash
cd apps/frontend
npm test -- --run 'app/(painel)/eventos/events-view.test.tsx' \
  'app/(painel)/evidencias/evidence-view.test.tsx' tests/resources.test.ts
```

Expected: FAIL against incident-only resources and synthetic initial filters.

**Step 3: Implement global/incident resources and UI**

Use the shared public contract types. Derive filter options from API facets. Preserve query state in the URL and append cursor pages. Never call example-data builders unless the existing development/test-only gate explicitly permits them.

**Step 4: Run frontend checks**

```bash
cd apps/frontend
npm test -- --run
npm run typecheck
npm run lint
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/frontend
git commit -m "feat(frontend): display real ARGUS events and evidence"
```

### Task 7: Validate a recent ARGUS dump and browser journeys

**Files:**

- Create: `apps/backend/ingestion-data/scripts/validate_event_projections.py`
- Create: `apps/backend/ingestion-data/tests/unit/scripts/test_validate_event_projections.py`
- Modify: `apps/backend/ingestion-data/README.md`
- Modify: `apps/frontend/tests/live-e2e-runtime.test.ts`
- Modify: `artefatos/sprint3/modelagem.md`

**Step 1: Write a failing reconciliation-script test**

Execute the validator against a controlled canonical set and projection reader. Assert non-zero exit for:

- eligible count different from projected Event count;
- missing source lineage;
- an Evidence without its persisted accepted correlation;
- an eligible unlinked Event absent from the global projection.

Assert a zero exit and a JSON report for a reconciled set.

Run:

```bash
cd apps/backend/ingestion-data
.venv/bin/pytest tests/unit/scripts/test_validate_event_projections.py -q
```

Expected: FAIL because the validator does not exist.

**Step 2: Implement the read-only validator**

Accept an explicit local canonical-set path or explicit dataset version. Print counts by source dataset, linked/unlinked totals, Evidence total, quality flags, and deterministic-ID samples. Never activate a dataset or mutate projections.

**Step 3: Validate the most recent available real dump**

First discover the latest local imported canonical set. If no recent local dump exists, perform read-only discovery in AWS using exactly:

```bash
aws s3api list-objects-v2 --bucket "$ARGUS_ARCHIVE_BUCKET" \
  --profile default --region us-east-1
```

Download only the selected dump/canonical artifacts to a temporary directory if needed, run the normal import/projector path locally, and save the JSON reconciliation output outside the production data path. Do not use profile `nora` and do not change active AWS state.

**Step 4: Run browser E2E journeys**

Start the local API and frontend against the projected test dataset, then execute the real browser journeys:

- Incidentes -> Eventos -> detalhe;
- Incidentes -> Evidências -> Evento;
- Eventos global -> Sem incidente -> próxima página.

Capture failures as test assertions, not screenshots alone.

**Step 5: Update operational documentation and run full suites**

```bash
cd apps/backend/ingestion-data
.venv/bin/pytest -q
cd ../api
npm test -- --run
npm run build
cd ../../frontend
npm test -- --run
npm run build
```

Expected: all checks PASS; the reconciliation report proves no eligible Event was silently discarded and no Evidence lacks a correlation.

**Step 6: Commit**

```bash
git add apps/backend/ingestion-data/scripts/validate_event_projections.py \
  apps/backend/ingestion-data/tests/unit/scripts/test_validate_event_projections.py \
  apps/backend/ingestion-data/README.md \
  apps/frontend/tests/live-e2e-runtime.test.ts \
  artefatos/sprint3/modelagem.md
git commit -m "test: validate ARGUS event and evidence flow end to end"
```

### Task 8: Review and integrate safely

**Files:**

- Review all changed files from `2c55285..HEAD`.

**Step 1: Verify scope and working tree**

```bash
git status --short
git diff --check 2c55285..HEAD
git diff --stat 2c55285..HEAD
```

Expected: no uncommitted implementation changes and no whitespace errors.

**Step 2: Perform contract and mutation review**

For each acceptance criterion, identify the test that fails if the behavior is removed or reversed. Confirm production code contains no fixture imports and no hard-coded example filters.

**Step 3: Re-run targeted cross-layer smoke checks**

Run the projector, correlation, API route, frontend resource, and E2E tests together after the final diff review.

**Step 4: Integrate only into a clean original checkout**

Verify the original checkout is still clean and still points at the expected integration branch. Integrate the feature commits using a non-destructive fast-forward or explicit cherry-picks. If the original checkout is dirty or moved unexpectedly, stop and report the exact paths instead of stashing or overwriting anything.

**Step 5: Final verification in the original checkout**

Run the cross-layer smoke checks again from the integrated checkout. Do not run a Terraform update as part of this task unless separately requested after integration.
