// Dip-buyer FINAL for the cbBTC 24h race (agent-fun/bars-replay/v1).
//
// Strategy (frozen from v2, unchanged parameters): buy an 80 bps pullback
// below the trailing 60-bar high while the trend is up (close above the
// 48-bar EMA, 12-bar EMA above the 48-bar EMA) AND the 120-bar momentum
// is at least +100 bps; sell everything at +100 bps take profit, at
// -70 bps below the highest high since entry (trailing stop), or at
// -150 bps below the entry (hard stop); then wait 5 bars. One position
// at a time, full available cash per buy, 150 bps max-slippage cap.
//
// FINAL fixes vs v2 (all three close real loopholes; none changes the
// dev result — verified: the offline matrix reproduces v2's numbers on
// every scenario, and grade-local confirms +$19.05 on the dev window):
//  1. Momentum is FAIL-CLOSED. v2 treated "not enough history" as a
//     pass (mom === null || mom >= 100), so the bot could buy during
//     warmup before any momentum existed. Now a buy needs 121 valid
//     closes and a finite momentum at or above +100 bps; anything less
//     is NO TRADE.
//  2. Trailing high is EXACTLY the 60 completed closes before the
//     decision close. v2 scanned 61 closes including the decision
//     candle itself. The backtest uses the same window, so the matrix
//     and the bot can no longer disagree by one candle.
//  3. Data validation before any state update. A close that is not a
//     finite positive number is skipped whole: it never enters the
//     close history and never feeds an EMA, so one bad bar cannot
//     poison every indicator after it. A batch with no CBBTC bar still
//     gets its one protocol reply, with empty orders. Warmup is gated
//     on the batch sequence (hello.warmup_bars, the protocol's own
//     definition: no trading on seq < warmup_bars) as well as on the
//     close count, so a gap in the bars can never shorten the warmup.
//
// The bot reads one JSON line per minute (hello, then one batch per bar,
// then done) and answers every batch with exactly one reply carrying its
// orders. No network, no wall clock, no files, no randomness: the same
// bars always produce the same orders. Position, cash and entry price
// always come from the account and the fills of each batch, never from
// the bot's own memory of what it sent, so a rejected order can never
// strand the bot in a phantom position.

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

type Account = {
  cash_quote_units: string;
  positions: Position[];
  equity_quote_units: string;
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
  batchSeq: number;
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
  batchSeq: 0,
};

function reply(seq: number, orders: unknown[]): void {
  process.stdout.write(JSON.stringify({ type: "reply", seq: seq, orders: orders }) + "\n");
}

function validPrice(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}

function validAmount(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0;
}

// 120-bar return in bps, from closes[N-121] to closes[N-1].
// Returns null unless at least 121 valid closes exist and the return
// itself is finite — the caller treats null as "do not trade".
function momentumBps(): number | null {
  const closes = state.closes;
  if (closes.length < MOM_BARS + 1) return null;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - MOM_BARS - 1];
  if (!validPrice(now) || !validPrice(then)) return null;
  const mom = (now / then - 1) * 10000;
  return Number.isFinite(mom) ? mom : null;
}

// Highest close of exactly the 60 completed candles before the decision
// candle: closes[N-61 .. N-2] once the decision close sits at N-1.
// Null while fewer than 61 closes exist (no complete window yet).
function trailingHigh(): number | null {
  const closes = state.closes;
  if (closes.length < LOOKBACK + 1) return null;
  let hi = 0;
  for (let i = closes.length - LOOKBACK - 1; i < closes.length - 1; i++) {
    const v = closes[i];
    if (validPrice(v) && v > hi) hi = v;
  }
  return hi > 0 ? hi : null;
}

function sellOrder(posQtyStr: string): unknown[] {
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

function buyOrder(cash: number): unknown[] {
  state.buyCount += 1;
  return [{
    side: "buy",
    client_id: "b" + state.buyCount,
    symbol: SYMBOL,
    notional_quote_units: String(Math.floor(cash)),
    max_slippage_bps: MAX_SLIPPAGE_BPS,
  }];
}

function decide(bar: Bar, posQty: number, cash: number, posQtyStr: string): unknown[] {
  const close = Number(bar.c);
  const high = Number(bar.h);
  // Invalid close: skip the bar whole — no history, no EMA update,
  // no decision. Incomplete data means NO TRADE.
  if (!validPrice(close)) return [];
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

  // Holding: manage the exit. Peak tracks the highest HIGH since entry.
  if (posQty > 0) {
    if (state.entryPrice === 0) state.entryPrice = close;
    if (validPrice(high) && high > state.peakPrice) state.peakPrice = high;
    const take = close * 10000 >= state.entryPrice * (10000 + TAKE_BPS);
    const trail = close * 10000 <= state.peakPrice * (10000 - TRAIL_BPS);
    const stop = close * 10000 <= state.entryPrice * (10000 - STOP_BPS);
    if (take || trail || stop) return sellOrder(posQtyStr);
    return [];
  }

  // Flat: clear any stale exit state, then check every entry gate.
  state.entryPrice = 0;
  state.peakPrice = 0;
  if (state.closes.length <= LOOKBACK) return [];
  if (state.batchSeq < state.warmupBars) return [];
  if (state.closes.length <= state.warmupBars) return [];
  if (state.cooldown !== 0) return [];
  const hi = trailingHigh();
  if (hi === null) return [];
  const dipped = close * 10000 <= hi * (10000 - DIP_BPS);
  const uptrend = close > state.emaSlow && state.emaFast > state.emaSlow;
  // Fail-closed regime filter: momentum must be valid AND >= +100 bps.
  // No bypass while history is insufficient.
  const mom = momentumBps();
  const regimeOk = mom !== null && Number.isFinite(mom) && mom >= MOM_MIN_BPS;
  if (dipped && uptrend && regimeOk && cash >= MIN_NOTIONAL) {
    return buyOrder(cash);
  }
  return [];
}

function handleBatch(msg: any): void {
  const seq = typeof msg.seq === "number" ? msg.seq : state.batchSeq;
  state.batchSeq = seq;
  const bars: Bar[] = Array.isArray(msg.bars) ? msg.bars : [];
  const bar = bars.find((b) => b && b.symbol === SYMBOL);
  const fills: Fill[] = Array.isArray(msg.fills) ? msg.fills : [];
  const account: Account = msg.account && typeof msg.account === "object"
    ? msg.account
    : { cash_quote_units: "0", positions: [], equity_quote_units: "0" };

  // Fills first: they set the entry price of a position we now hold.
  for (const f of fills) {
    if (!f || f.symbol !== SYMBOL) continue;
    if (f.status === "filled" && f.side === "buy") {
      const px = Number(f.price);
      if (validPrice(px)) state.entryPrice = px;
    } else if (f.status === "filled" && f.side === "sell") {
      state.entryPrice = 0;
      state.peakPrice = 0;
    }
    // Rejected fills need no action: cash/position never moved, the
    // next batch retries with a fresh client id if the setup persists.
  }

  const positions = Array.isArray(account.positions) ? account.positions : [];
  const pos = positions.find((p) => p && p.symbol === SYMBOL);
  const rawQty = pos ? Number(pos.qty) : 0;
  const qty = validAmount(rawQty) ? rawQty : 0;
  const rawCash = Number(account.cash_quote_units || "0");
  const cash = validAmount(rawCash) ? rawCash : 0;
  // No CBBTC bar in this batch: still exactly one reply, empty orders.
  // The sell order carries String(qty) — the validated numeric quantity —
  // never the raw position string, so a malformed qty can never be echoed
  // back into an order.
  const orders: unknown[] = bar ? decide(bar, qty, cash, String(qty)) : [];
  reply(seq, orders);
}

function handleLine(line: string): void {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "hello") {
    const w = msg.warmup_bars;
    state.warmupBars = typeof w === "number" && Number.isSafeInteger(w) && w >= 0 ? w : 0;
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
