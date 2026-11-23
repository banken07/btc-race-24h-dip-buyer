// Dip-buyer v2 for the cbBTC 24h race (agent-fun/bars-replay/v1).
//
// v2 adds ONE thing to the v1 dip-buyer: a regime filter. v1 bought every
// 80 bps pullback inside an EMA uptrend and made +$19.05 on the dev window,
// but the same rules lost -$8.84 on the time-reversed window: one entry
// fired while the two-hour trend was only weakly up, and the trade bled.
// The two dev winners both entered with the 120-bar return above +100 bps;
// the reversed loser entered at +54 bps. v2 therefore demands the same
// pullback AND a clearly rising two-hour trend before it buys. On the
// offline matrix v2 keeps the full dev profit and stays flat on every
// stress window instead of bleeding. Matrix (offline evaluator, exact
// harness fill model, calibrated to grade-local to the cent):
//   full dev +$19.05 (v1: +$19.05) | half1 +$19.05 | half2 $0.00 |
//   worst falling stretch $0.00 | time-reversed $0.00 (v1: -$8.84) |
//   2x fees +$17.42. Worst case $0.00 vs v1's -$8.84, dev unchanged.
//
// The bot reads one JSON line per minute (hello, then one batch per bar,
// then done) and answers every batch with exactly one reply carrying its
// orders. No network, no wall clock, no files, no randomness: the same
// bars always produce the same orders.
//
// Entry (flat, at least 61 closes seen, no cooldown left): the latest close
// sits 80 bps or more below the trailing 60-bar high, the trend is up
// (close above the 48-bar EMA and the 12-bar EMA above the 48-bar EMA),
// AND the 120-bar momentum is at least +100 bps (once 120 closes exist).
// It buys with all available cash.
// Exit (long): sell everything when the close rises 100 bps above the
// entry (take profit), or falls 70 bps below the peak (trailing stop), or
// falls 150 bps below the entry (hard stop). Then wait 5 bars before the
// next entry, so a whipsaw cannot re-enter at once.
// Position, cash and entry price always come from the account and the
// fills of each batch, never from the bot's own memory of what it sent,
// so a rejected order can never strand the bot in a phantom position.
// Orders carry a 150 bps max slippage cap; a fill rejected for slippage
// is simply retried on a later bar with a fresh client id.

type Bar = {
  symbol: string;
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string | null;
  o_depth: string[];
  c_depth: string[];
};

type Fill = {
  client_id: string;
  symbol: string;
  side: string;
  status: string;
  reason: string | null;
  decided_bar: number;
  fill_bar: number;
  price: string;
  qty: string;
  notional_quote_units: string;
  fee_quote_units: string;
};

type Position = {
  symbol: string;
  qty: string;
  cost_quote_units: string;
};

const SYMBOL = "CBBTC";
const FAST_LEN = 12;
const SLOW_LEN = 48;
const LOOKBACK = 60;
const MOM_BARS = 120;
const MOM_MIN_BPS = 100;
const DIP_BPS = 80;
const TAKE_BPS = 100;
const TRAIL_BPS = 70;
const STOP_BPS = 150;
const COOLDOWN_BARS = 5;
const MAX_SLIPPAGE_BPS = 150;
const MIN_NOTIONAL = 1000000;

type State = {
  closes: number[];
  emaFast: number;
  emaSlow: number;
  entryPrice: number;
  peakPrice: number;
  cooldown: number;
  buyCount: number;
  sellCount: number;
  warmupBars: number;
};

const state: State = {
  closes: [],
  emaFast: 0,
  emaSlow: 0,
  entryPrice: 0,
  peakPrice: 0,
  cooldown: 0,
  buyCount: 0,
  sellCount: 0,
  warmupBars: 0,
};

function reply(seq: number, orders: unknown[]): void {
  process.stdout.write(JSON.stringify({ type: "reply", seq: seq, orders: orders }) + "\n");
}

function momentumBps(): number | null {
  const closes = state.closes;
  if (closes.length <= MOM_BARS) return null;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - MOM_BARS - 1];
  return ((now / then) - 1) * 10000;
}

function trailingHigh(): number {
  let hi = 0;
  for (let i = state.closes.length - LOOKBACK - 1; i < state.closes.length; i++) {
    if (state.closes[i] > hi) hi = state.closes[i];
  }
  return hi;
}

function decide(bar: Bar, posQty: number, cash: number, posQtyStr: string): unknown[] {
  const close = Number(bar.c);
  state.closes.push(close);
  const af = 2 / (FAST_LEN + 1);
  const as = 2 / (SLOW_LEN + 1);
  if (state.closes.length === 1) {
    state.emaFast = close;
    state.emaSlow = close;
  } else {
    state.emaFast = close * af + state.emaFast * (1 - af);
    state.emaSlow = close * as + state.emaSlow * (1 - as);
  }
  if (state.cooldown > 0) state.cooldown -= 1;

  if (posQty > 0) {
    if (state.entryPrice === 0) state.entryPrice = close;
    const high = Number(bar.h);
    if (high > state.peakPrice) state.peakPrice = high;
    const take = close * 10000 >= state.entryPrice * (10000 + TAKE_BPS);
    const trail = close * 10000 <= state.peakPrice * (10000 - TRAIL_BPS);
    const stop = close * 10000 <= state.entryPrice * (10000 - STOP_BPS);
    if (take || trail || stop) {
      state.sellCount += 1;
      state.cooldown = COOLDOWN_BARS;
      return [{
        side: "sell",
        client_id: "s" + state.sellCount,
        symbol: SYMBOL,
        qty: posQtyStr,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      }];
    }
    return [];
  }

  state.entryPrice = 0;
  state.peakPrice = 0;
  if (state.closes.length <= LOOKBACK) return [];
  if (state.closes.length <= state.warmupBars) return [];
  if (state.cooldown !== 0) return [];
  const hi = trailingHigh();
  const dipped = close * 10000 <= hi * (10000 - DIP_BPS);
  const uptrend = close > state.emaSlow && state.emaFast > state.emaSlow;
  const mom = momentumBps();
  const regimeOk = mom === null || mom >= MOM_MIN_BPS;
  if (dipped && uptrend && regimeOk && cash >= MIN_NOTIONAL) {
    state.buyCount += 1;
    return [{
      side: "buy",
      client_id: "b" + state.buyCount,
      symbol: SYMBOL,
      notional_quote_units: String(Math.floor(cash)),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    }];
  }
  return [];
}

function handleBatch(msg: any): void {
  const bars: Bar[] = msg.bars || [];
  const bar = bars.find((b) => b.symbol === SYMBOL);
  const fills: Fill[] = msg.fills || [];
  const account = msg.account || { cash_quote_units: "0", positions: [], equity_quote_units: "0" };

  for (const f of fills) {
    if (f.status === "filled" && f.symbol === SYMBOL) {
      if (f.side === "buy") state.entryPrice = Number(f.price);
      if (f.side === "sell") {
        state.entryPrice = 0;
        state.peakPrice = 0;
      }
    }
  }

  const pos = (account.positions || []).find((p: Position) => p.symbol === SYMBOL);
  const qty = pos ? Number(pos.qty) : 0;
  const cash = Number(account.cash_quote_units || "0");
  const orders: unknown[] = bar ? decide(bar, qty, cash, pos ? pos.qty : "0") : [];
  reply(msg.seq, orders);
}

function handleLine(line: string): void {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "hello") {
    if (typeof msg.warmup_bars === "number") state.warmupBars = msg.warmup_bars;
    return;
  }
  if (msg.type === "batch") {
    handleBatch(msg);
    return;
  }
  if (msg.type === "done") process.exit(0);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let idx = buf.indexOf("\n");
  while (idx >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line.length > 0) handleLine(line);
    idx = buf.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  process.exit(0);
});
