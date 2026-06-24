'use strict';

require('dotenv').config();

const { Connection, Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const { PumpStreamLogger } = require('pump-stream-logger');
const { simulateBuy, simulateSell, formatSol, formatTokens, marketCapSol } =
  require('pump-laserstream-parser');

const { CreatorFilter }   = require('./filter');
const { PositionTracker } = require('./positions');
const { Buyer }           = require('./buyer');

// ─── Config loader ─────────────────────────────────────────────────────────────

function loadConfig() {
  const required = ['HELIUS_LASERSTREAM_ENDPOINT', 'SOLANA_RPC_URL', 'WALLET_PRIVATE_KEY'];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
  }

  const csv = key => (process.env[key] ?? '').split(',').map(s => s.trim()).filter(Boolean);

  return {
    endpoint:     process.env.HELIUS_LASERSTREAM_ENDPOINT,
    apiKey:       process.env.HELIUS_API_KEY ?? '',
    rpcUrl:       process.env.SOLANA_RPC_URL,
    privateKey:   process.env.WALLET_PRIVATE_KEY,

    creatorWhitelist: csv('CREATOR_WHITELIST'),
    creatorBlacklist: csv('CREATOR_BLACKLIST'),

    buyAmountSol:    parseFloat(process.env.BUY_AMOUNT_SOL    ?? '0.05'),
    slippageBps:     parseInt(process.env.SLIPPAGE_BPS         ?? '300'),
    priorityFee:     parseInt(process.env.PRIORITY_FEE_MICROLAMPORTS ?? '100000'),

    takeProfitPct:   parseFloat(process.env.TAKE_PROFIT_PERCENT ?? '100'),
    stopLossPct:     parseFloat(process.env.STOP_LOSS_PERCENT   ?? '30'),
    maxPositions:    parseInt(process.env.MAX_OPEN_POSITIONS     ?? '5'),
  };
}

// ─── PumpSniper ────────────────────────────────────────────────────────────────

class PumpSniper {
  /**
   * @param {object} [overrides] - Override any .env config values programmatically
   */
  constructor(overrides = {}) {
    this._cfg = { ...loadConfig(), ...overrides };

    // Solana connection + wallet
    this._conn   = new Connection(this._cfg.rpcUrl, 'confirmed');
    this._wallet = Keypair.fromSecretKey(bs58.decode(this._cfg.privateKey));

    // Sub-systems
    this._filter    = new CreatorFilter({
      whitelist: this._cfg.creatorWhitelist,
      blacklist: this._cfg.creatorBlacklist,
    });

    this._positions = new PositionTracker({
      takeProfitPercent: this._cfg.takeProfitPct,
      stopLossPercent:   this._cfg.stopLossPct,
      maxOpenPositions:  this._cfg.maxPositions,
    });

    this._buyer = new Buyer({
      connection:               this._conn,
      wallet:                   this._wallet,
      priorityFeeMicroLamports: this._cfg.priorityFee,
      slippageBps:              this._cfg.slippageBps,
    });

    // pump-stream-logger handles all terminal output
    this._logger = new PumpStreamLogger({
      endpoint: this._cfg.endpoint,
      apiKey:   this._cfg.apiKey,
      show: {
        trades:      true,
        ammTrades:   false,  // focus on bonding curve
        creates:     true,
        completions: true,
        pools:       false,
        status:      true,
      },
    });

    this._running  = false;
    this._buyLocks = new Set();   // mints currently being bought (dedup concurrent triggers)
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  async start() {
    if (this._running) return;
    this._running = true;

    // Prefetch the pump.fun fee recipient so the first buy has no extra latency
    await this._buyer.fetchFeeRecipient();

    const fs = this._filter.summary();
    console.log(`\n  Wallet:    ${this._wallet.publicKey.toBase58()}`);
    console.log(`  Filter:    ${fs.mode} (${fs.whitelistSize} allowed, ${fs.blacklistSize} blocked)`);
    console.log(`  Buy:       ${this._cfg.buyAmountSol} SOL  slippage ${this._cfg.slippageBps / 100}%`);
    console.log(`  Exit:      TP +${this._cfg.takeProfitPct}%  SL -${this._cfg.stopLossPct}%`);
    console.log(`  Max pos:   ${this._cfg.maxPositions}\n`);

    // Wire raw events from the logger's underlying client before starting
    this._logger.on('create', ev  => this._onCreate(ev).catch(e => this._onError(e)));
    this._logger.on('trade',  trade => this._onTrade(trade));

    await this._logger.start();
  }

  async stop() {
    this._running = false;
    await this._logger.stop();
    this._printSummary();
  }

  // ── Event handlers ───────────────────────────────────────────────────────────

  async _onCreate(ev) {
    const creator = ev.creator ?? ev.user;

    if (!this._filter.isAllowed(creator)) return;
    if (this._positions.isFull()) {
      console.log(`  [skip]  ${ev.name ?? ev.mint} — max positions reached`);
      return;
    }
    if (this._positions.has(ev.mint)) return;
    if (this._buyLocks.has(ev.mint))  return;

    this._buyLocks.add(ev.mint);
    try {
      await this._executeBuy(ev);
    } finally {
      this._buyLocks.delete(ev.mint);
    }
  }

  _onTrade(trade) {
    if (!this._positions.has(trade.mint)) return;

    // Derive current price from virtual reserves in the trade event
    const vSol   = trade.virtual_sol_reserves;
    const vToken = trade.virtual_token_reserves;
    if (!vSol || !vToken) return;

    // Price = vSol / vToken (lamports per raw token unit)
    const currentPrice = (BigInt(vSol) * 1_000_000n) / BigInt(vToken);

    const { shouldSell, reason } = this._positions.checkExit(trade.mint, currentPrice);
    if (shouldSell) {
      this._executeSell(trade.mint, reason).catch(e => this._onError(e));
    }
  }

  _onError(err) {
    console.error(`  [error] ${err.message}`);
  }

  // ── Trade execution ──────────────────────────────────────────────────────────

  async _executeBuy(ev) {
    const buyLamports = BigInt(Math.round(this._cfg.buyAmountSol * 1e9));

    // Use reserves from the create event to estimate token output
    const curve = {
      virtual_quote_reserves: BigInt(ev.virtual_sol_reserves   ?? ev.virtual_quote_reserves ?? 30_000_000_000n),
      virtual_token_reserves: BigInt(ev.virtual_token_reserves ?? 1_000_000_000_000n),
    };
    const { tokensOut } = simulateBuy(buyLamports, curve);

    console.log(`  [buy]  ${ev.name ?? '?'} (${ev.symbol ?? '?'})  ${formatSol(buyLamports)} → ~${formatTokens(tokensOut)}`);

    let result;
    try {
      result = await this._buyer.buy({
        mint:         ev.mint,
        bondingCurve: ev.bonding_curve,
        tokenAmount:  tokensOut,
        solSpend:     buyLamports,
      });
    } catch (err) {
      console.error(`  [buy failed]  ${ev.mint}  ${err.message}`);
      return;
    }

    // Entry price = lamports spent / token units received
    const entrySolPerToken = curve.virtual_token_reserves > 0n
      ? (curve.virtual_quote_reserves * 1_000_000n) / curve.virtual_token_reserves
      : 0n;

    this._positions.open(ev.mint, {
      bondingCurve:    ev.bonding_curve,
      solSpent:        result.solSpent,
      tokenAmount:     result.tokenAmount,
      entrySolPerToken,
      creator:         ev.creator ?? ev.user,
      name:            ev.name   ?? null,
      symbol:          ev.symbol ?? null,
      txSig:           result.signature,
    });

    console.log(`  [open]  ${ev.name ?? ev.mint}  sig:${result.signature.slice(0, 8)}…  positions:${this._positions.count()}`);
  }

  async _executeSell(mint, reason) {
    const pos = this._positions.getOpen().find(p => p.mint === mint);
    if (!pos) return;

    const balance = await this._buyer.getTokenBalance(mint);
    const amount  = balance > 0n ? balance : pos.tokenAmount;

    console.log(`  [sell] ${pos.name ?? mint}  ${reason}  ${formatTokens(amount)} tokens`);

    let result;
    try {
      result = await this._buyer.sell({
        mint:         mint,
        bondingCurve: pos.bondingCurve,
        tokenAmount:  amount,
        minSolOut:    0n,   // position tracker already verified threshold
      });
    } catch (err) {
      console.error(`  [sell failed]  ${mint}  ${err.message}`);
      return;
    }

    const closed = this._positions.close(mint, {
      solReceived: result.solReceived,
      reason,
      txSig:       result.signature,
    });

    if (closed) {
      const sign = closed.pnlLamports >= 0n ? '+' : '';
      console.log(`  [close] ${pos.name ?? mint}  P&L: ${sign}${formatSol(closed.pnlLamports)}  (${sign}${closed.pnlPercent.toFixed(1)}%)`);
    }
  }

  _printSummary() {
    const pnl = this._positions.pnlSummary();
    const sign = pnl.totalPnlSol >= 0 ? '+' : '';
    console.log(`\n  ── Session summary ──────────────────────`);
    console.log(`  Trades:  ${pnl.totalTrades}  (${pnl.wins}W / ${pnl.losses}L)`);
    console.log(`  P&L:     ${sign}${pnl.totalPnlSol.toFixed(4)} SOL`);
    console.log(`  Still open: ${this._positions.count()}`);
  }
}

module.exports = { PumpSniper };
