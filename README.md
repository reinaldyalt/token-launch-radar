# Token Launch Radar

[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/c/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/reinaldyalt/token-launch-radar/rank.svg)](https://make.fun/c/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/reinaldyalt/token-launch-radar/reward.svg)](https://make.fun/c/token-radar-01)

A token launch radar: it reads a sealed DefiLlama snapshot of 758 protocols, finds the ones
that record no token, ranks them by the implied value of the token they might one day issue,
and shows a reader how to farm each one before it launches. Built for the
[token-radar-01 bounty](https://make.fun/bounty/token-radar-01) on make.fun.

## What it does

- **Board** — 198 pre-token protocols ranked by implied value: the full 40-protocol watchlist
  (TVL of $50M+ with no token on record) plus 158 more pre-token protocols the radar finds
  early, down to the smallest the snapshot tracks.
- **Value model (radar-2)** — each protocol is priced off its own category's live-token peers:
  the median market-cap-to-TVL ratio of the tokens its category already trades at, blended
  toward the global median when a category has few peers, halved by a launch discount, then
  adjusted for seven-day TVL growth, age with no token, and chain reach. No protocol name is
  ever special-cased; the same function scores every row.
- **Farm plans** — every row carries a seven-step plan derived from its category, chains, TVL
  and age, each step with a cost and a time.
- **Live token view** — the protocols whose tokens already trade, set aside with their market
  caps: the peers the model prices the board against.

The dashboard is a static page (no framework, no network) with search, category, chain and
scope filters, sortable columns, and a detail view for every protocol showing the model's full
breakdown and its farm plan.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path to snapshot.json>
```

`main.ts` (Node 22, standard library only) reads the snapshot, writes `board.json` and
`data.js` to the output directory, copies `dashboard/` and `screenshots/`, and writes
`dossier.json` with the vendored make.fun library. Open `out/dashboard/index.html` in a
browser to use the dashboard.

## Honesty note

"No token" means the DefiLlama record carries no token, never that the protocol has none.
Implied value is this radar's own estimate from the snapshot's figures: not a price, not a
prediction that a token will launch, and not financial advice.

## License

MIT. See [LICENSE](LICENSE).
