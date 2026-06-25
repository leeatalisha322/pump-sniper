# 🎯 pump-sniper

> A fast, focused **[pump.fun](https://pump.fun) token sniper bot** for Solana — streams new token launches in real time over Helius **LaserStream**, filters by creator wallet, auto-buys on the bonding curve, and manages exits with take-profit / stop-loss.

<p align="center">
  <img alt="Solana"    src="https://img.shields.io/badge/Solana-mainnet-14F195?logo=solana&logoColor=white">
  <img alt="Node"      src="https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white">
  <img alt="Stream"    src="https://img.shields.io/badge/stream-LaserStream%20gRPC-blueviolet">
  <img alt="License"   src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="Status"    src="https://img.shields.io/badge/status-experimental-orange">
</p>

---

## ⚠️ Disclaimer

This software is provided **for educational and research purposes only**.

- Trading pump.fun tokens is **extremely high-risk**. Most tokens go to zero. You can lose 100% of your funds.
- This is unaudited, experimental software. **Use a burner wallet** funded with only what you can afford to lose.
- Sniping bots may violate the terms of service of some providers. **You are solely responsible** for how you use this.
- Nothing here is financial advice.

> 🔐 **Never commit your `.env` or private key.** The `.gitignore` already excludes `.env`, but double-check before pushing.

---

## ✨ Features

| | Feature | Description |
|---|---|---|
| ⚡ | **Real-time streaming** | Subscribes to pump.fun `create` and `trade` events over Helius LaserStream (gRPC) for minimal latency. |
| 🎯 | **Creator filtering** | Whitelist trusted creator wallets, or run in *open mode* and blacklist known rug wallets. |
| 🤖 | **Auto-buy** | Builds, signs, and sends bonding-curve buy transactions the moment a matching token is created. |
| 📈 | **Position management** | In-memory tracker with configurable take-profit, stop-loss, and a max-open-positions cap. |
| 🔁 | **Auto-exit** | Watches live trades to re-price open positions and sells automatically when TP/SL thresholds are crossed. |
| 🛡️ | **Slippage & priority fees** | Per-trade slippage tolerance and configurable compute-unit priority fee for fast landing. |
| 🧮 | **P&L summary** | Tracks wins/losses and total realized P&L; prints a session summary on shutdown. |
| 🧪 | **Tested core** | Pure unit tests for filtering, position logic, and instruction encoding — no network or wallet required. |

---

## 🏗️ Architecture

```
                  Helius LaserStream (gRPC)
                            │
                  create / trade events
                            │
                            ▼
        ┌──────────────────────────────────────┐
        │            PumpSniper                 │  index.js / src/sniper.js
        │   (orchestrator + event handlers)     │
        └──────────────────────────────────────┘
            │              │               │
   ┌────────┘     ┌────────┘      ┌────────┘
   ▼              ▼               ▼
┌────────────┐ ┌──────────────┐ ┌───────────────┐
│CreatorFilter│ │PositionTracker│ │     Buyer     │
│ allow/block │ │ TP / SL / max │ │ buy/sell tx   │
│  (filter.js)│ │ (positions.js)│ │  (buyer.js)   │
└────────────┘ └──────────────┘ └───────────────┘
                                         │
                                         ▼
                              Solana RPC (send tx)
```

**Flow:**
1. A new token `create` event arrives → `CreatorFilter` decides if the creator is allowed.
2. If allowed and positions aren't full → `Buyer` builds and sends a bonding-curve **buy**.
3. The position is recorded in `PositionTracker` with its entry price.
4. Incoming `trade` events re-price open positions → when **take-profit** or **stop-loss** is hit, `Buyer` sends a **sell**.
5. Closed positions accumulate into the running **P&L** summary.

### Project layout

```
pump-sniper/
├── index.js              # Entry point + library exports + signal handling
├── src/
│   ├── sniper.js         # PumpSniper — orchestrator, config loader, event wiring
│   ├── filter.js         # CreatorFilter — whitelist / blacklist logic
│   ├── positions.js      # PositionTracker — TP/SL, open/close, P&L
│   └── buyer.js          # Buyer — builds & sends pump.fun buy/sell transactions
├── test.js               # Unit tests (no network / wallet needed)
├── .env.example          # Configuration template
└── package.json
```

---

## 📦 Requirements

- **Node.js ≥ 18**
- A **Helius API key** with **LaserStream** access — <https://helius.dev>
- A funded **Solana wallet** (base58-encoded private key) — **use a burner!**
- A Solana **RPC endpoint** for sending transactions (Helius works for both)

---

## 🚀 Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Create your config from the template
cp .env.example .env

# 3. Edit .env — add your Helius key, RPC URL, and wallet private key
#    (and optionally creator whitelist / buy parameters)
nano .env

# 4. Run the test suite (no network or wallet required)
npm test

# 5. Start sniping
npm start
```

On startup the bot prints its active configuration:

```
  Wallet:    7xKp...9fQ2
  Filter:    whitelist (3 allowed, 1 blocked)
  Buy:       0.05 SOL  slippage 3%
  Exit:      TP +100%  SL -30%
  Max pos:   5
```

Press **Ctrl-C** to stop gracefully — the bot shuts down the stream and prints a session summary.

---

## ⚙️ Configuration

All configuration is via environment variables (see [`.env.example`](.env.example)).

### Connection

| Variable | Description |
|---|---|
| `HELIUS_LASERSTREAM_ENDPOINT` | LaserStream gRPC endpoint (e.g. `https://mainnet.helius-rpc.com:10000`) |
| `HELIUS_API_KEY` | Your Helius API key |
| `SOLANA_RPC_URL` | RPC URL used to send buy/sell transactions |
| `WALLET_PRIVATE_KEY` | **Base58-encoded** private key. Keep secret — never commit. |

### Creator filter

| Variable | Default | Description |
|---|---|---|
| `CREATOR_WHITELIST` | *(empty)* | Comma-separated creator wallets to buy from. **Empty = buy from anyone** (open mode). |
| `CREATOR_BLACKLIST` | *(empty)* | Comma-separated wallets to always skip (checked even in whitelist mode). |

### Buy parameters

| Variable | Default | Description |
|---|---|---|
| `BUY_AMOUNT_SOL` | `0.05` | SOL to spend per snipe |
| `SLIPPAGE_BPS` | `300` | Slippage tolerance in basis points (`300` = 3%) |
| `PRIORITY_FEE_MICROLAMPORTS` | `100000` | Priority fee for faster transaction landing |

### Position management

| Variable | Default | Description |
|---|---|---|
| `TAKE_PROFIT_PERCENT` | `100` | Sell when up this % (`100` = 2×) |
| `STOP_LOSS_PERCENT` | `30` | Sell when down this % |
| `MAX_OPEN_POSITIONS` | `5` | Max simultaneous open positions |

---

## 🧩 Using as a library

Every component is exported and can be embedded in your own tooling:

```js
const { PumpSniper, CreatorFilter, PositionTracker, Buyer } = require('pump-sniper');

// Override any .env value programmatically
const sniper = new PumpSniper({
  buyAmountSol: 0.1,
  takeProfitPct: 200,        // sell at 3×
  stopLossPct: 25,
  creatorWhitelist: ['Alpha111...', 'Beta222...'],
});

await sniper.start();
// ... later
await sniper.stop();   // prints session P&L summary
```

You can also adjust the creator filter at **runtime**:

```js
const filter = new CreatorFilter({ whitelist: ['Alpha111'] });
filter.allow('Delta444');   // add to whitelist
filter.block('BadActor');   // blacklist + remove from whitelist
filter.unallow('Alpha111'); // remove from whitelist
console.log(filter.summary());
```

---

## 🧪 Testing

```bash
npm test
```

The suite is **fully offline** — no RPC, no wallet, no API key needed. It covers:

- ✅ `CreatorFilter` — open mode, whitelist mode, runtime allow/block/unallow
- ✅ `PositionTracker` — open/close, take-profit & stop-loss triggers, max-positions, P&L math
- ✅ Buy/sell **instruction encoding** — discriminators and little-endian argument layout

```
──────────────────────────────────────────────────
Results: 28 passed, 0 failed
```

---

## 🔍 How it works (deeper dive)

- **Streaming** is handled by [`pump-stream-logger`](https://www.npmjs.com/package/pump-stream-logger), which surfaces `create` and `trade` events from LaserStream. The sniper focuses on **bonding-curve** activity (AMM trades are off by default).
- **Pricing** is derived on the fly from each trade's *virtual reserves*: `price = virtual_sol_reserves / virtual_token_reserves`. Entry price is captured at buy time; live trades re-price the position to evaluate exits.
- **Transactions** are built directly against the pump.fun program (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`) using the instruction layout from the official IDL. The `Buyer`:
  - Derives stable PDAs (`global`, `__event_authority`) and fetches the on-chain `fee_recipient` once at startup to avoid first-buy latency.
  - Prepends compute-budget instructions (priority fee) and an idempotent associated-token-account creation.
  - Encodes `buy`/`sell` args as `discriminator(8) + amount(8) + sol_bound(8)` little-endian.
- **Concurrency safety**: a `_buyLocks` set dedupes concurrent triggers for the same mint so the bot never double-buys.

> ℹ️ **Note:** sell proceeds are currently estimated from the slippage-adjusted `minSolOut` rather than fetched from transaction meta, so P&L is approximate. Wiring up an RPC fetch of the confirmed transaction would make realized P&L exact.

---

## 🗺️ Roadmap ideas

- [ ] Exact realized P&L from confirmed transaction meta
- [ ] Persistent position storage (survive restarts)
- [ ] Trailing stop-loss
- [ ] Multiple buy tranches / DCA
- [ ] Telegram / Discord notifications
- [ ] Optional Jito bundle submission for landing priority

---

## 📄 License

[MIT](LICENSE) © leeatalisha322

---

<p align="center"><sub>Built for Solana • pump.fun • LaserStream — trade responsibly, use a burner. 🔥</sub></p>
