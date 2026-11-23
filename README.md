# Dip Buyer — cbBTC 24h race bot

[![make.fun](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A trading bot for the [make.fun](https://make.fun) competition
**btc-race-24h-20261123-0511**: race a bot trading Coinbase Wrapped BTC
(cbBTC) on 1-minute on-chain bars for 24 hours, starting with $1,000 of
paper money. Ranked by net PnL; only entries that made money on the
frozen dev window race.

## Strategy

Disciplined dip-buyer, long only, one position at a time:

- **Entry**: with at least 61 closes seen, when the latest close sits
  80 bps or more below the trailing 60-bar high and the trend is up
  (close above the 48-bar EMA, 12-bar EMA above the 48-bar EMA), buy
  with all available cash.
- **Exit**: sell everything when the close rises 100 bps above the
  entry fill price (take profit), falls 70 bps below the highest high
  since entry (trailing stop), or falls 150 bps below the entry
  (hard stop). Then wait 5 bars before the next entry.
- **Safety**: position, cash and entry price always come from the
  account and fills of each batch, never from the bot's own memory,
  so a rejected order can never strand it in a phantom position.
  Orders carry a 150 bps max-slippage cap; a rejected fill is
  retried on a later bar with a fresh client id.

## Running

`main.ts` speaks `agent-fun/bars-replay/v1` on stdin/stdout (Node 22,
standard library only, no network, no clock, no files, no randomness).
Grade it on the dev window with the kit:

```
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process --worktree
```

## Dev result

Local grade on the frozen dev window (1,440 bars): **net PnL
+$19.05**, 4 trades, max drawdown 0.53%, guardrails met.
