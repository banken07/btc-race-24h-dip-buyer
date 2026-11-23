// Dip-buyer for the cbBTC 24h race (agent-fun/bars-replay/v1).
//
// Idea: buy a sharp pullback while the trend is up, bank a fixed profit,
// and cut losers fast. Long only, one position, fully invested on entry.
// The bot reads one JSON line per minute (hello, then one batch per bar,
// then done) and answers every batch with exactly one reply carrying its
// orders. No network, no wall clock, no files, no randomness: the same
// bars always produce the same orders.
//
// Rules, all from the bar stream and the account the harness sends:
// - Flat, at least 61 closes seen, no cooldown left: when the latest close
//   sits 80 bps or more below the trailing 60-bar high, and the trend is
//   up (close above the 48-bar EMA and the 12-bar EMA above the 48-bar
//   EMA), buy with all available cash.
// - Long: track the fill price of the buy and the highest close since the
//   entry. Sell everything when the close rises 100 bps above the entry
//   (take profit), or falls 70 bps below the peak (trailing stop), or
//   falls 150 bps below the entry (hard stop). Then wait 5 bars before
//   the next entry, so a whipsaw cannot re-enter at once.
// - Position, cash and entry price always come from the account and the
//   fills of each batch, never from the bot's own memory of what it sent,
//   so a rejected order can never strand the bot in a phantom position.
// - Orders carry a 150 bps max slippage cap; a fill rejected for
//   slippage is simply retried on a later bar with a fresh client id.

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
const DIP_BPS = 80;
const TAKE_BPS = 100;
const TRAIL_BPS = 70;
const STOP_BPS = 150;
const COOLDOWN_BARS = 5;
const MAX_SLIPPAGE_BPS = 150;
const MIN_NOTIONAL = 1000000;

const closes: number[] = [];
let emaFast = 0;
let emaSlow = 0;
let entryPrice = 0;
let peakPrice = 0;
let cooldown = 0;
let buyCount = 0;
let sellCount = 0;
let warmupBars = 0;

function reply(seq: number, orders: unknown[]): void {
  process.stdout.write(JSON.stringify({ type: "reply", seq: seq, orders: orders }) + "\n");
}

function handleBatch(msg: any): void {
  const bars: Bar[] = msg.bars || [];
  const bar = bars.find((b) => b.symbol === SYMBOL);
  const fills: Fill[] = msg.fills || [];
  const account = msg.account || { cash_quote_units: "0", positions: [], equity_quote_units: "0" };

  for (const f of fills) {
    if (f.status === "filled" && f.symbol === SYMBOL) {
      if (f.side === "buy") entryPrice = Number(f.price);
      if (f.side === "sell") {
        entryPrice = 0;
        peakPrice = 0;
      }
    }
  }

  const pos = (account.positions || []).find((p: Position) => p.symbol === SYMBOL);
  const qty = pos ? Number(pos.qty) : 0;
  const cash = Number(account.cash_quote_units || "0");
  const orders: unknown[] = [];

  if (bar) {
    const close = Number(bar.c);
    closes.push(close);
    const af = 2 / (FAST_LEN + 1);
    const as = 2 / (SLOW_LEN + 1);
    if (closes.length === 1) {
      emaFast = close;
      emaSlow = close;
    } else {
      emaFast = close * af + emaFast * (1 - af);
      emaSlow = close * as + emaSlow * (1 - as);
    }
    if (cooldown > 0) cooldown -= 1;

    if (qty > 0) {
      if (entryPrice === 0) entryPrice = close;
      const high = Number(bar.h);
      if (high > peakPrice) peakPrice = high;
      const take = close * 10000 >= entryPrice * (10000 + TAKE_BPS);
      const trail = close * 10000 <= peakPrice * (10000 - TRAIL_BPS);
      const stop = close * 10000 <= entryPrice * (10000 - STOP_BPS);
      if (take || trail || stop) {
        sellCount += 1;
        orders.push({
          side: "sell",
          client_id: "s" + sellCount,
          symbol: SYMBOL,
          qty: String(pos.qty),
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        cooldown = COOLDOWN_BARS;
      }
    } else {
      entryPrice = 0;
      peakPrice = 0;
      if (closes.length > LOOKBACK && closes.length > warmupBars && cooldown === 0) {
        let hi = 0;
        for (let i = closes.length - LOOKBACK - 1; i < closes.length; i++) {
          if (closes[i] > hi) hi = closes[i];
        }
        const dipped = close * 10000 <= hi * (10000 - DIP_BPS);
        const uptrend = close > emaSlow && emaFast > emaSlow;
        if (dipped && uptrend && cash >= MIN_NOTIONAL) {
          buyCount += 1;
          orders.push({
            side: "buy",
            client_id: "b" + buyCount,
            symbol: SYMBOL,
            notional_quote_units: String(Math.floor(cash)),
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
        }
      }
    }
  }

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
    if (typeof msg.warmup_bars === "number") warmupBars = msg.warmup_bars;
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
