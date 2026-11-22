---
title: Cloudflare workflow recovery smoke test
description: Exercise durable workflow recovery in an isolated deployment.
---

The smoke test deploys a separate Worker, Workflow, container app and D1
database. It uses the real Cloudflare Checkpointer, Python engine, application
API and SvelteKit run pages. Its test adapter serves fixture prices through
the EODHD client and injects failures around real platform operations. The
regular fixture command and the production Worker do not load these adapters.

The only shared resources are the two **dev** R2 buckets. Fixture symbols
have a fresh `SMOKE-` prefix and published portfolio results use IDs created
in the smoke database. Temporary objects use the generated run IDs. The
smoke Worker has no production bindings or automatic cron. The runner sends
duplicate scheduled occurrences with the fixture date through the same
dispatch function used by the hourly trigger.

## Deploy and run

Use a Wrangler login allowed to create D1 databases and deploy script,
Workflow and container resources. Docker must be running. Supply a dotenv
file with S3 credentials for `raw-market-data-dev` and
`processed-market-data-dev`. The setup command reads only the three
`R2_*` settings needed for S3 and generates its own management token and
app signing key. It writes them to a private temporary directory.

Run these commands from the repository root.

```sh
setup=$(node --import tsx scripts/cloudflare-smoke/prepare.ts .dev.vars)
smoke_dir=$(jq -r .directory <<< "$setup")
smoke_name=$(jq -r .resource <<< "$setup")
pnpm exec wrangler d1 create "$smoke_name" --update-config=false
```

Set `smoke_db` to the database ID printed by the last command. Apply the
repository migrations and the smoke-only fault marker table to that database.

```sh
node --import tsx scripts/cloudflare-smoke/configure.ts "$smoke_dir" "$smoke_db"
smoke_config="$smoke_dir/wrangler.smoke.json"
pnpm exec wrangler d1 migrations apply "$smoke_name" --remote --config "$smoke_config"
pnpm exec wrangler d1 execute "$smoke_name" --remote --config "$smoke_config" \
  --file scripts/cloudflare-smoke/setup.sql
pnpm --filter app build
pnpm exec wrangler deploy --config "$smoke_config" --tsconfig "$PWD/tsconfig.json" \
  --secrets-file "$smoke_dir/secrets.json"
```

Set `smoke_url` to the deployed `workers.dev` URL for the named smoke
Worker. Run the assertions. The runner uses Wrangler for platform controls and
instance logs and uses the Python environment to read the published Parquet.

```sh
node --import tsx scripts/cloudflare-smoke/run.ts "$smoke_dir" "$smoke_url"
```

The runner writes fixture API results, Cloudflare step logs and a Parquet
publication to an `evidence-*` subdirectory. Keep the adjacent secret and
private key files private. Use a fresh smoke database for a new scenario, so
earlier enabled fixtures do not receive the fixed scheduled occurrence.

## Run locally

The same suite runs against a `wrangler dev` session: workerd's local
Workflows, D1 and Durable Objects, with the two dev R2 buckets as remote
bindings. They stay remote because the Python engine reads and writes R2 over
S3 itself. This exercises the Cloudflare Checkpointer, the Workflow entry
points and `cloudflareServices` without deploying anything. It does not
show durability on Cloudflare's infrastructure (eviction across machines,
real retry timing, container cold starts), so a deployed run is still due
before a production cutover.

Prepare the directory as above, then write a local config. Local D1 needs no
`wrangler d1 create`.

```sh
setup=$(node --import tsx scripts/cloudflare-smoke/prepare.ts .dev.vars)
smoke_dir=$(jq -r .directory <<< "$setup")
smoke_name=$(jq -r .resource <<< "$setup")
node --import tsx scripts/cloudflare-smoke/configure.ts "$smoke_dir" --local \
  --engine-url http://localhost:8790
smoke_config="$smoke_dir/wrangler.smoke.json"
state="$smoke_dir/state"
pnpm exec wrangler d1 migrations apply "$smoke_name" --local --config "$smoke_config" --persist-to "$state"
pnpm exec wrangler d1 execute "$smoke_name" --local --config "$smoke_config" --persist-to "$state" \
  --file scripts/cloudflare-smoke/setup.sql
pnpm --filter app build
```

`--engine-url` calls the engine as a local process instead of the container.
Leave it out to use the container through Docker, where `wrangler dev` can
start one. On the yoloagent VM, workerd's container sidecar timed out, so the
engine runs with `uv` on the same dev buckets:

```sh
(set -a; . "$smoke_dir/.dev.vars"; set +a
 ARTIFACT_BUCKET=raw-market-data-dev PROCESSED_BUCKET=processed-market-data-dev \
   uv run --directory containers/engine uvicorn data_service_engine.app:app --port 8790) &
pnpm exec wrangler dev --config "$smoke_config" --env-file "$smoke_dir/.dev.vars" \
  --persist-to "$state" --port 8787 --tsconfig "$PWD/tsconfig.json" --enable-containers=false &
node --import tsx scripts/cloudflare-smoke/run.ts "$smoke_dir" http://localhost:8787
```

With a `localhost` URL, the runner sends its pause, resume and describe
commands to the local session (`wrangler workflows instances … --local`).
Use a fresh directory for each run.

## Retention

List the two dev bucket configurations. The only object expiry should be
the 30-day `runs/` rule on the raw bucket. The default multipart abort rules
can stay on both buckets.

```sh
pnpm exec wrangler r2 bucket lifecycle list raw-market-data-dev
pnpm exec wrangler r2 bucket lifecycle list processed-market-data-dev
```

If the rule is missing, first confirm the raw `runs/` prefix is empty or
contains only temporary workflow artifacts eligible for expiration. Add the
rule while preserving existing multipart settings.

```sh
pnpm exec wrangler r2 bucket lifecycle add raw-market-data-dev \
  expire-temporary-run-artifacts runs/ --expire-days 30
```

Retained raw history starts with `dataset=`. Published data remains in the
processed bucket. Neither matches the raw bucket's object expiry rule.

## Recorded run

On 2026-11-19 UTC, Worker and Workflow `data-service-workflow-smoke-f7b3ef21`
ran with Worker version `47f234c6-c96d-4b3b-80a0-73e6609bb181`. D1
migrations 0001–0014 and the smoke fault table were applied to its dedicated
database.

| Scenario                        | Workflow instance ID                                                        | Observed result                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduled portfolio recovery    | `18e6a26e-65d2-47f3-b64b-19e1103b6a5c`                                      | Cloudflare accepted the launch before its reply was discarded. A duplicate tick during an unavailable status lookup returned no additional occurrence. The app showed both missing inputs. Cloudflare recorded a durable sleep, rechecked and finished the original four-step definition after an edit. Holdings ran once. |
| Scheduled upstream publications | `ae87caca-7eb3-4c94-9ed0-5884b736cc8f`, `c829ea4b-980f-40b1-a88d-99226b724` | Both asset runs finished and published prices for the portfolio's processing date of 2024-01-05.                                                                                                                                                                                                                           |
| Python and publication retries  | `18e6a26e-65d2-47f3-b64b-19e1103b6a5c`                                      | Volatility and publication each had one failed and one successful platform attempt. The retried Python call returned the same Parquet reference and summary, and the retried publication recorded the same ETag and size observed before the metadata failure. The completed run page showed the published result.         |
| Waiting timeout                 | `dde09596-e837-4e5b-bc39-3412ebac71e2`                                      | The deadline was recorded as 2026-11-19T17:03:45.765Z. The missing fixture assets were reported in the API and run page.                                                                                                                                                                                                   |
| New manual rerun                | `690b0646-2887-44d7-853b-820ff5017fbd`                                      | The assignment accepted a new run after the timeout. It recorded the original run as `rerunOf`, ran from holdings and used the edited `publish-updated` step.                                                                                                                                                              |
| Terminal input                  | `9bcc3242-575a-4244-8af7-4e82dc413bde`                                      | A processing date before the asset's start date failed on the first attempt.                                                                                                                                                                                                                                               |
| Bounded transient outage        | `d554a163-e014-4ae0-8ea3-4078e03d3690`                                      | A fixture provider 503 exhausted the three retries, for four attempts in total.                                                                                                                                                                                                                                            |

A second pass paused instance `0e3ab484-7804-42a5-86d9-4675a91047f3`
during the wait and resumed it after both upstream publications. The platform
checkpoint still held the original deadline, 2026-11-19T17:11:32.942Z. The
holdings checkpoint was unchanged. The current Parquet publication was
2,882 bytes and decoded to one row with the expected volatility
`0.16655193949753969` from three returns.

Cloudflare reported a 2,592,000-second age transition for prefix `runs/`
on the dev raw bucket and no object deletion rule on the dev processed
bucket. The raw prefix was empty before the smoke scenario. Production
configuration was outside the deployment.

On 2026-11-22 the full suite also passed locally (see [Run locally](#run-locally)),
after run execution moved to platform-neutral services (#57): the
Checkpointer, RunLauncher, RunCoordinator and per-host service layers. The
engine ran as a local process. The scheduled portfolio paused while waiting,
resumed and published 2,882 bytes, with two attempts each for volatility and
publication. The timeout failed at its dependency step, the rerun completed
the edited definition, the terminal input failed on attempt 1, and the
transient outage used all 4 attempts.

After removing the superseded download, calculation, queue, and processor
paths (issue #39), the contracted Worker and single Python container were
re-deployed to `data-service-workflow-smoke-f7b3ef21` (Worker version
`84243533-0934-4596-abdb-c51f78bc2786`, container digest
`sha256:546e4d8715e52cfd18220fd6eb50b58954daefa3b7e08caa53a1fd7d32c718d7`).
The full recovery suite passed again: paused/resumed scheduled portfolio run
`e8ab1c75-cb47-4476-a7d6-6596d11a7197` published 2,882 bytes decoding to
volatility `0.16655193949753969`, timeout run
`ee211194-474f-47f5-9ad3-e3603899a5a9` reported missing upstream assets,
manual rerun `9dd4b5a9-24ef-4aba-a004-719239d4dd1a` ran the edited
definition, terminal run `332fc249-fa3e-4127-8b72-77b576063ba2` failed on
attempt 1, and transient outage run `e36dae80-1b01-48c4-9764-e463acda24dc`
exhausted all 4 attempts.
