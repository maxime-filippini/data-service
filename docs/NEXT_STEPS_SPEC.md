# Data service: next steps

Status: proposed implementation spec, 2026-10-07.

Baseline: Worker `develop` at `bfb45ae` (PR #4 merged) and the sibling
`data-service-processor` checkout at `d304db3`. These are implementation
baselines, not evidence of a successful deployment. No remote resources or
live execution were verified while preparing this spec.

Sources: repository code and documentation, plus
[Design market data pipeline](codex://threads/01a0fbce-c3f8-7d20-bb0e-90a1458704e1).
The API details below are proposed contracts. Symbol management, manual
ingestion, and scheduled ingestion are not implemented yet.

## Outcome and scope

An operator can register or disable symbols through POST requests, ingest
history without inserting D1 rows manually, and let the daily schedule update
one canonical Parquet object per symbol. HTTP clients retain a supported JSON
API; calculation clients read Parquet from the processed bucket.

The immediate milestone retains the implemented **daily full-history snapshot
→ rebuild** strategy. The earlier discussion described initial backfill followed
by one-day deltas and merges. That remains an optimization, but cannot be wired
into the current rebuild selector: it selects only the latest completed run,
so a one-day input would replace the entire historical dataset.

## Current implementation

| Capability | Evidence and behavior |
| --- | --- |
| Run-based ingestion | `src/market-data/ingestion.ts` creates a run, fetches data, stores an immutable envelope, and records completion/failure. Neither an HTTP route nor cron invokes it. |
| Raw storage | `src/market-data/r2-raw-store.ts` writes create-only version-1 validated JSON envelopes, rather than exact provider response bytes. |
| Control plane | Initial migration and `src/market-data/control-plane/d1.ts` track runs, frozen job membership, canonical revisions, and applied inputs. |
| Processing API | Authenticated create/read/claim/complete/fail endpoints under `/processing-jobs`, with one active job per symbol. |
| Scheduled processing | `src/market-data/processing-dispatch.ts` creates `rebuild` jobs at version `v1` for latest unapplied snapshots and republishes queued IDs. Unresolved failed inputs block automatic job creation for their symbol. |
| Delivery | `src/index.ts`, `src/processor-container.ts`, and `wrangler.jsonc` connect Queue delivery to a private synchronous Python endpoint; execution is serial. |
| Python | Sibling repository implements CLI/HTTP execution, manifest/ETag validation, merge/rebuild, Parquet production with Polars, and Worker callbacks. It does not produce returns. |
| HTTP serving | `GET /market-data/eodhd` directly retrieves validated provider JSON without R2 access or ingestion records. The legacy cache adapter and duplicated route have been removed. |
| Coverage | Raw observed range/row count exist; neither proves complete trading-session coverage. Python deliberately omits `completeThrough`. |
| Operations | No enforced raw retention, automatic claim recovery, or atomic R2-write/D1-completion protocol. |

## Invariants

- D1 owns coordination and lineage; R2 owns payloads. Python accesses D1 only
  through the Worker API and reads only the frozen manifest's R2 inputs.
- Ingestion runs and processing jobs have separate identities and states.
  Job membership and precedence are immutable after creation.
- Keep one canonical key per symbol:
  `dataset=prices_eod/symbol=<symbol>/data.parquet`.
- Disabling stops future scheduled ingestion without deleting history,
  canceling active work, or removing canonical data.
- Claiming is atomic ownership (`queued → processing`), separate from queue
  publication. Terminal-job redelivery must cause no new writes.
- Queue acknowledgement depends on durable job state, not only a successful
  container response. R2 upload and D1 completion are separate operations.
- Keep Hono adapters thin, Effect Schema validation at boundaries, and live
  layer composition outside business programs. Retain prepared SQL and Wrangler
  migrations; an ORM or framework migration is outside this milestone.

## Delivery sequence

### 1. Validate the existing deployed pipeline

The linked chat's last deployment attempt failed during Docker image building
with `unknown flag: --load`. Confirm the Docker/Buildx build path now works and
record the exact Worker and processor revisions used for a smoke test.
Follow [README deployment prerequisites](../README.md#container-deployment-setup):
both buckets, D1 migration, both queues, and runtime secrets. Configure a
reachable Worker route/domain for callbacks; `workers_dev` is disabled here.

Use a disposable test symbol with a real raw envelope and matching D1 metadata:

1. Create a processing job and inspect its frozen manifest.
2. Execute the Python CLI; verify readable v1 Parquet, the actual output ETag,
   completed job state, applied inputs, and one revision increment.
3. Use another snapshot to demonstrate schedule → Queue → Worker consumer →
   container → Worker completion. Redelivery after completion causes no rerun.
4. Introduce an invalid input; verify terminal failure and lock release.
   Inspect ambiguous failures before submitting replacement work.

Deliver a repeatable fixture/helper and `docs/MANUAL_TESTING.md`, distinguishing
local state-machine exercises, direct processor/R2 tests, and deployed delivery.
Wrangler local R2 is not the processor's S3 storage. A fabricated ETag or manual
`complete` callback does not prove a Parquet write. Add CI that checks out both
repositories at explicit compatible revisions and runs their existing checks.

### 2. Add the symbol registry and management API

Add a new D1 migration for `tracked_symbols`:

| Field | Contract |
| --- | --- |
| `symbol` | Primary key; provider-qualified, path-safe symbol such as `AAPL.US`. |
| `provider` | Only `eodhd` supported initially. |
| `enabled` | Integer constrained to 0/1. |
| `backfill_start_date` | Valid inclusive ISO calendar date defining snapshot history. |
| `created_at`, `updated_at` | Server-generated UTC timestamps; preserve creation time on updates. |
| `disabled_at` | Set on disable transition, clear on re-enable. |

Use a dedicated `MANAGEMENT_API_TOKEN` with the existing bearer middleware.
The processing token must not authorize registry changes or ingestion actions.
For existing symbols, reject provider changes: canonical keys and applied
history are currently symbol-based.

| Proposed route | Behavior |
| --- | --- |
| `POST /symbols` | Full configuration `{ symbol, provider, enabled, backfillStartDate }`; idempotent upsert. `201` on insert, `200` on update; return stored configuration. |
| `GET /symbols` | Order by symbol with optional enabled filter, default limit 50, maximum 100, and opaque next cursor. |
| `POST /symbols/:symbol/disable` | Idempotent disable; `200` with configuration, `404` if unknown. Re-enable through `POST /symbols`. |

Example registration:

```json
{
  "symbol": "AAPL.US",
  "provider": "eodhd",
  "enabled": true,
  "backfillStartDate": "2016-01-01"
}
```

Registration changes policy only; it does not fetch or create processing work.
Reject invalid/future dates, unsupported providers, invalid symbols, and unknown
JSON fields with `400`. Use `401` for missing/incorrect credentials and `409`
for attempts to change an existing provider. Changing the history start affects
future snapshots, never existing run manifests.

Acceptance: repeated registration creates one row; disable/re-enable preserves
execution history; management/processing credentials are not interchangeable;
paging covers the registry without omissions in an unchanged registry.

### 3. Expose manual snapshot ingestion and inspection

Add management-authenticated routes invoking the existing ingestion program
with EODHD, raw R2, and D1 live adapters:

```http
POST /symbols/AAPL.US/ingestion-runs
Idempotency-Key: <operator-generated-key>
Content-Type: application/json

{ "kind": "snapshot", "through": "2026-10-06" }
```

`snapshot` means explicit backfill/refresh from the registered history start
through the inclusive end date, defaulting to the previous UTC day. Reject
current/future UTC dates, end dates before the start, and unsupported kinds.
Exclude partial daily/correction requests while automatic processing uses
rebuild. Allow an explicit manual snapshot for disabled symbols: disabling
governs the schedule, while this action expresses operator intent.

Execute synchronously initially. On success, return `201` with run ID, frozen
requested range, status, and object metadata. Return `404` for unknown symbol,
`400` for invalid request, sanitized `502` plus run ID for provider/storage
failure, and `500` for configuration/database failure. Add management-protected
`GET /ingestion-runs/:runId` so a timeout can be resolved by inspecting state.

Persist an idempotency key scoped to symbol, alongside the frozen request,
before fetching. An identical repeat returns the terminal run without fetching
again; an in-progress repeat returns `409` with run ID. Reusing a key for
different intent returns `409`. A failed attempt needs a new key/run ID to
retry. Add control-plane methods for this: a caller-supplied run ID alone
does not make the existing ingestion program resumable.

After success, leave `raw_complete` inputs for the processing schedule.
Operators may create a job immediately through the existing processing API;
ingestion itself does not dispatch Python in this slice.

Acceptance: one HTTP action produces immutable raw bytes and matching metadata
without direct SQL; repeated keys produce no second fetch/object; errors remain
inspectable. If R2 writing succeeds but D1 finalization fails, retain and flag
the uncertain run for reconciliation rather than re-executing the same ID
against its create-only object key.

### 4. Wire scheduled ingestion into processing

Extend the existing 02:00 UTC handler:

```txt
enabled tracked symbols → full-history snapshots → raw_complete
→ rebuild jobs → queued IDs → Queue → Worker consumer → Python container
→ canonical Parquet → Worker callback → D1 revision/ETag/applied inputs
```

Freeze policy/range when admitting a run. Derive the previous UTC date from
the event's `scheduledTime`, rather than execution wall-clock time. Enforce D1
uniqueness for scheduled provider, symbol, and target date so repeated or
overlapping delivery cannot create duplicate attempts. A pre-fetch lookup
without a uniqueness constraint is insufficient.

Request `[backfillStartDate, previous UTC date]` each day. A new symbol's first
snapshot is its backfill; a re-enabled symbol catches up in its next snapshot.
This range is not a claim of complete exchange-session coverage.

Page the enabled registry and bound fetch concurrency, initially to one.
Isolate each symbol's failure and run processing dispatch for eligible existing
inputs and queued jobs even when other ingestion fails. Report stuck/in-progress
ingestion without overwriting it. Automatic retries of failed ingestion attempts
are deferred; the next daily full snapshot or explicit manual action can recover.

Add explicit snapshot/delta input-kind metadata before enabling this workflow:
the current schema cannot distinguish them. Only full-history snapshots may
enter automatic rebuild selection. New runs carry the snapshot kind; historical
unclassified runs require operator verification before automatic selection.
Never infer full history from row count or observed min/max dates. Define how
empty/partial provider responses are validated; an empty snapshot must not
silently erase nonempty canonical data.

Acceptance: two enabled symbols refresh independently; disabled symbols are
skipped; repeated events admit no duplicate run; one failure does not block
queued-job publication; inputs arriving during processing remain pending.
Demonstrate initial backfill and next-day refresh through the deployed pipeline.
Measure elapsed time/provider usage for the intended initial universe. If
synchronous ingestion cannot fit execution limits, add durable ingestion queue
admission/execution before expanding the universe.

### 5. Add operational visibility and controlled recovery

Add paginated management inspection of runs/jobs and canonical metadata per
symbol: active job, last error, age, revision/ETag, requested and observed ranges.
Use run/job/symbol identifiers in logs without credentials or response bodies.

Document reconciliation for stuck claims and upload/completion disagreement:
stop the writer, inspect frozen inputs plus actual R2 and D1 ETags, then choose
verified completion or fail/rebuild. Prevent replacement work while the original
writer may still run. Calling the current fail endpoint releases a lock but
does not stop a container.

Acceptance: operators distinguish delivery failure, transformation failure,
stuck ownership, and output/metadata disagreement without blind SQL editing.
Automatic leases require fencing and stale-writer tests; do not merely release
a lock after a timeout.

### 6. Enforce retention, then modernize HTTP serving

Implement D1-coordinated raw cleanup with a 30-day window, retaining the latest
successful snapshot and inputs referenced by queued/processing jobs. Add a
deletion reservation that prevents new jobs selecting inputs during cleanup.
Make deletion retryable and mark deleted inputs unavailable while preserving
audit references. Protect legacy cache objects separately: they share the raw
bucket. Provide a dry-run report and test cleanup/job-creation races before
enabling deletion. Do not enable blanket bucket-age expiration.

Next, add a bounded serving projection derived from processed data alongside
the explicit `/market-data/eodhd` provider proxy. Specify its format/publication
protocol separately; the Worker should not parse Parquet or reconstruct raw
inputs. The proxy remains available for on-demand provider JSON.

Before promising coverage, define exchange calendars, expected sessions, gaps,
and empty/partial responses. Keep `completeThrough` unset until implemented.
Serving metadata must identify its canonical revision and report when its
projection is behind Parquet.

Acceptance: cleanup protects referenced inputs, repeated deletion is safe, and
deleted inputs cannot enter manual jobs. Projection reads make no provider calls
or ingestion writes; pagination and stale/missing data have documented responses.
The separate provider proxy fetches directly and performs no persistence.

## Deferred work and decisions

- **Daily deltas/merge:** require explicit input kinds, snapshot-plus-delta rebuild
  selection, and retention preserving reconstructability. Validate historical
  corporate-action corrections before replacing full-history refreshes.
- **Returns:** specify adjustment basis, return definition, first-row behavior,
  and historical-correction recomputation before adding `returns_eod`.
- **Provider bytes/gzip:** version the raw contract and update writer/reader
  together, retaining compatibility with existing envelopes.
- **R2 credentials:** current settings supply one S3 credential pair. Verify
  effective raw-read and processed-read/write permissions before claiming least
  privilege. If separate credentials are needed, change both Python clients and
  container secrets; do not assume dashboard policy capabilities.
- **Transform upgrades:** define explicit reprocessing without new input; the
  current scheduler considers unapplied snapshots, not transformation changes.
- **Scale/publication:** ingestion queues, larger datasets, parallel processors,
  alternative serving stores, and versioned publication need measured demand.
  Retain the single canonical object contract for the immediate milestone.

## Verification and definition of done

Run existing Worker checks (`pnpm test`, `pnpm typecheck`) and add behavioral
tests for auth separation, registry transitions, ingestion identity, snapshot
eligibility, and failure isolation. When changing Python contracts, run
`uv run pytest` and Ruff check/format check. Integration assertions must inspect
real Parquet and ETags, not just mocked HTTP success.

The immediate milestone is steps 1–4: a registered symbol reaches canonical
Parquet through both manual ingestion and the daily schedule; disable prevents
new scheduled ingestion; repeated requests/events preserve immutable history;
run/job state explains the outcome. Steps 5–6 follow before expanding unattended
operation and migrating public HTTP reads.

## Related documentation

- [Architecture](MARKET_DATA_ARCHITECTURE.md) and [glossary](../CONTEXT.md).
- [Sequence diagram](sequence-diagram.md), including planned ingestion.
- [Effect services](effect-service-layer-patterns.md),
  [validation](effect-schema-validation.md), and
  [HTTP composition](effect-http-app-composition.md).
