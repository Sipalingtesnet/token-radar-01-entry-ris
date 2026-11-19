# Token Launch Radar — token-radar-01 entry

![bounty](https://make.fun/badge/token-radar-01.svg)
![rank](https://make.fun/badge/token-radar-01/Sipalingtesnet/token-radar-01-entry-ris/rank.svg)
![reward](https://make.fun/badge/token-radar-01/Sipalingtesnet/token-radar-01-entry-ris/reward.svg)

[make.fun bounty: token-radar-01](https://make.fun/bounty/token-radar-01)

## What this is

A program that reads the bounty's sealed DeFiLlama snapshot — 758 protocols,
each with TVL of at least $5M, dated 2026-11-14 — and ranks the protocols that
record no token yet by an implied launch value. From that one snapshot it
writes a ranked board (`board.json`), a self-contained offline dashboard, and
a dossier.

The board holds 198 ranked candidates and covers all 40 house-watchlist
protocols. Nothing consults the clock, randomness, or the network, so the
same snapshot always produces byte-identical outputs.

## The model

    implied value = TVL × category multiple × growth factor × maturity factor × breadth factor

- **Category multiple** — the median market-cap/TVL ratio of the snapshot's
  own live protocols in the same category. Categories with fewer than 3 live
  samples fall back to the global median of all ratios. Every multiple is
  clamped to [0.05, 3].
- **Growth factor** — from the 7-day TVL change, clamped to [-20, +50] percent
  before it scales the base (`1 + change/100 × 1.2`).
- **Maturity factor** — from the listing age: 0.75 for a brand-new listing,
  rising linearly to 1.25 at four years (1460 days). An unknown listing age
  is treated as 365 days.
- **Breadth factor** — adds 3% per extra chain beyond the first, up to 8
  chains (`1 + 0.03 × min(chains − 1, 7)`).

The result is rounded to a positive integer. Every factor is exposed on each
dashboard row so the ranking can be audited against the snapshot.

An implied value is this board's own model claim, not a forecast or a promise.

## The screen

A protocol qualifies as a launch candidate when all of the following hold:

- It records no token: no `symbol` and no `gecko_id` in the snapshot.
- Its category is not one of Bridge, Canonical Bridge, Liquid Staking,
  Liquid Restaking, Restaked BTC, or CEX.
- Its name carries no version marker (a trailing V2, v3.1, 2.0 and the like —
  re-deployments, not launches).
- Its name contains no wrapped/staked/staking wording as a whole word.
- Its name does not begin with an exchange name (Binance, Coinbase, Bybit,
  Kraken, Bitget, OKX, Bitfinex, Gemini).

Every watchlist protocol is ranked regardless of the screen, so coverage of
the house watchlist is complete. Ties in implied value are broken by TVL,
then by slug.

## Run it

```
node main.ts --input <snapshot.json>
```

Set `MAKEFUN_OUTPUT_DIR` to choose the output folder (or pass `--output`).
Node 22+, standard library only, no network access. `--input` also accepts a
directory containing `snapshot.json`.

Outputs written to the output folder:

- `board.json` — the ranked board: slug, name, rank, implied value, farm steps.
- `data.js` — the full auditable payload the dashboard loads (`../data.js`).
- `dashboard/` — the offline dashboard, copied from this repository.
- `screenshots/` — three captures of the built dashboard, copied from here.
- `dossier.json` — built by the vendored kit library from every other output
  file, so it is written last. Byte-identical across runs of the same snapshot.

A board that would fail the gate (row count, ranks, values, watchlist
coverage, farm steps) is refused before anything is written; each refusal
goes to stderr with a distinct exit code.

## Repository layout

- `main.ts` — entry program: argument parsing, snapshot loading, board
  self-check, output assembly, dossier build.
- `lib/model.ts` — snapshot parsing, the launch-candidate screen, the value
  model, farm-plan generation, board assembly and payload.
- `vendor/makefun-board.ts` — the kit's dossier builder, used unchanged.
- `dashboard/` — `index.html`, `app.css`, `app.js`. Vanilla JavaScript,
  fully offline, no external requests.
- `screenshots/` — three captures of the built dashboard.

## Farming plans

Each board row carries five concrete farm steps, generated per protocol:

1. Set up a fresh wallet and bridge funds to the protocol's main chain, with
   a cost range and setup time.
2. A category-specific core action (swap, supply, hedge, deposit, mint) with
   a suggested amount and time cost.
3. A second category-specific action to build a steady weekly history, with
   running costs (gas, interest, funding).
4. A second-surface step: repeat one core action on the protocol's second
   chain (or another product surface) and follow official announcement
   channels for points or airdrop news.
5. A tracking/safety step: keep an activity log, re-check official
   announcements monthly, use official links only, never share a seed phrase
   or sign blind approvals.

Amounts are sized to the protocol's TVL tier: protocols at or above $1B TVL
get the top of each range. They are working-fund suggestions, not advice.
