---
title: Hypothetical portfolio returns
description: Synchronous return histories for saved portfolios and inline holdings at one calculation date.
---

`POST /api/calculate` with type `hypothetical_portfolio_returns` returns past
returns using the holdings selected at one calculation date. It reads canonical
price files and returns JSON or Arrow. It does not create a calculation/run,
change holdings, or write results to R2.

## Request

Use `asOf` as the calculation date and supply an ordered `portfolios` list.
Each entry is either a saved portfolio reference or an inline holdings object;
the two forms can be mixed freely. Up to 100 entries are accepted.

```json
{
  "type": "hypothetical_portfolio_returns",
  "asOf": "2026-10-16",
  "params": {
    "start_date": "2020-01-01"
  },
  "portfolios": [
    { "portfolioId": "6f1d9a3c-58c4-4d55-9b5e-0a5e2b8f4e11" },
    {
      "holdings": [
        { "symbol": "AAPL.US", "weight": 0.6 },
        { "symbol": "MSFT.US", "weight": 0.4 }
      ]
    }
  ]
}
```

The management endpoint requires `Authorization: Bearer <MANAGEMENT_API_TOKEN>`.
The app exposes the same route at `/app-api/calculate` with its existing Access
and same-origin checks.

`params.start_date` is optional. Omit it, or use `{}` for params, to return all
available shared history through `asOf`. It is an inclusive bound on the return
observation date. The engine retains the price observation before that date so
it can calculate the first return. A requested start before available coverage
does not invent earlier observations. `asOf` defaults to the previous UTC day
when omitted, as with other ad hoc calculations.

The existing singular `portfolio` field also works for this type. Supply either
`portfolio` or `portfolios`, never both. Any portfolio-taking calculation type
can use the batch field; single requests keep their existing response shape.

## Holdings and return semantics

For a saved reference, the Worker loads snapshots on or before `asOf`; the type
chooses the most recent of those. That single holdings set is applied to every
historical interval, including dates before the snapshot existed. Snapshots
before that chosen set do not change past exposures, and future snapshots and
price observations are excluded. A saved portfolio with no eligible snapshot
is rejected. Inline holdings need no saved portfolio or holdings date, but all
symbols must already be tracked in `prices_eod` (disabled symbols count).

Returns are simple adjusted-close returns, expressed as decimals: `0.01` means
1%. The portfolio return is the sum of each asset return multiplied by its
selected weight. The same weights apply in every interval, implying constant
weight rebalancing. Weights are used as supplied, including short exposures and
totals other than one; no normalization, currency conversion, transaction costs
or cash interest are applied.

Within each portfolio, the engine uses consecutive price dates on which every
held symbol has an observation. It does not forward-fill prices or replace
missing returns with zero. A gap can therefore produce a multi-day interval;
`previous_date` identifies its beginning explicitly. Different portfolios can
have different coverage. Fewer than two shared prices, a window with no returns,
or non-finite calculated returns cause an error.

This is hypothetical exposure history. An old `asOf` limits observation dates
in today's canonical price history; it does not restore a historical data vintage.

## Response

JSON uses the existing `{ "rows": [...] }` envelope. Every row in a batch has:

| Column            | Meaning                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `portfolio_index` | Zero-based position in the input list; distinguishes inline entries and repeated saved IDs. |
| `portfolio_id`    | Saved ID, or null for inline holdings.                                                      |
| `as_of`           | Calculation date used to select holdings and cap prices.                                    |
| `holdings_date`   | Effective date of the selected saved snapshot, or null for inline holdings.                 |
| `previous_date`   | Beginning of the shared-price interval.                                                     |
| `date`            | End of that interval; the return observation date.                                          |
| `return`          | Constant-weight simple return over the interval.                                            |

Rows follow input order, then ascending observation date. Singular requests
omit `portfolio_index`. Repeated saved IDs remain separate batch entries.
`portfolio_rows` reserves `portfolio_index` for batch identification, so types
using that formatting helper must not declare it in their value-column schema.

Use `Accept: application/vnd.apache.arrow.stream` for the same columns in an
Arrow IPC stream. A caller such as tail-lib can select an input index, then use
`date` and `return` as the dates and values of a `TimeSeries`. The HTTP endpoint
has the existing roughly 60-second engine-call timeout, including cold start.

## Failures

Batches are all-or-nothing: a failure never returns partial rows and never writes
result objects. The Worker validates all selections before calling the engine.
Malformed/empty/oversized lists return `400`; untracked symbols return `400`,
unknown saved portfolios `404`, and a portfolio with no eligible holdings `422`.
Worker lookup errors identify the input index in their message.

Expected engine failures, such as missing prices or a start date after `asOf`,
return `422` with indexed detail:

```json
{
  "error": "Invalid request",
  "detail": {
    "portfolioIndex": 1,
    "portfolioId": null,
    "error": "No prices_eod data for MISSING.US"
  }
}
```

Unexpected engine/storage failures remain `500`; an unreachable engine is `503`
and a timeout is `504`. Single-portfolio requests retain the existing legacy
error handling, where execution failures can surface as `500`.
