'use strict';

/**
 * PositionTracker
 *
 * Keeps an in-memory record of every open position and computes whether
 * take-profit or stop-loss thresholds have been crossed.
 */
class PositionTracker {
  /**
   * @param {object} opts
   * @param {number} opts.takeProfitPercent  - e.g. 100 means "sell when up 100%" (2x)
   * @param {number} opts.stopLossPercent    - e.g. 30 means "sell when down 30%"
   * @param {number} opts.maxOpenPositions   - refuse new buys above this count
   */
  constructor({ takeProfitPercent = 100, stopLossPercent = 30, maxOpenPositions = 5 } = {}) {
    this._tp   = takeProfitPercent / 100;  // fraction above entry
    this._sl   = stopLossPercent   / 100;  // fraction below entry
    this._max  = maxOpenPositions;
    this._open = new Map();  // mint → PositionData
    this._closed = [];
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  isFull() {
    return this._open.size >= this._max;
  }

  has(mint) {
    return this._open.has(mint);
  }

  count() {
    return this._open.size;
  }

  getOpen() {
    return [...this._open.values()];
  }

  getHistory() {
    return this._closed;
  }

  /**
   * Returns { shouldSell, reason } based on current price vs entry price.
   *
   * @param {string} mint
   * @param {bigint} currentSolPerToken - current price in lamports per raw token unit
   * @returns {{ shouldSell: boolean, reason: string|null }}
   */
  checkExit(mint, currentSolPerToken) {
    const pos = this._open.get(mint);
    if (!pos) return { shouldSell: false, reason: null };

    const entry   = Number(pos.entrySolPerToken);
    const current = Number(currentSolPerToken);
    if (entry === 0) return { shouldSell: false, reason: null };

    const change = (current - entry) / entry;

    if (change >= this._tp)
      return { shouldSell: true, reason: `take_profit (+${(change * 100).toFixed(1)}%)` };
    if (change <= -this._sl)
      return { shouldSell: true, reason: `stop_loss (${(change * 100).toFixed(1)}%)` };

    return { shouldSell: false, reason: null };
  }

  // ── Mutations ────────────────────────────────────────────────────────────────

  /**
   * Record a new open position after a successful buy.
   *
   * @param {string} mint
   * @param {object} data
   * @param {bigint} data.solSpent          - lamports spent
   * @param {bigint} data.tokenAmount       - raw token units received
   * @param {bigint} data.entrySolPerToken  - entry price (lamports per token unit)
   * @param {string} data.creator
   * @param {string} [data.name]
   * @param {string} [data.symbol]
   * @param {string} [data.txSig]
   */
  open(mint, data) {
    this._open.set(mint, {
      mint,
      openedAt: Date.now(),
      ...data,
    });
  }

  /**
   * Close a position (after sell) and move it to history.
   *
   * @param {string} mint
   * @param {object} result
   * @param {bigint} result.solReceived
   * @param {string} result.reason          - 'take_profit' | 'stop_loss' | 'manual'
   * @param {string} [result.txSig]
   * @returns {object|null} the closed position record
   */
  close(mint, result) {
    const pos = this._open.get(mint);
    if (!pos) return null;
    this._open.delete(mint);

    const pnlLamports = BigInt(result.solReceived) - BigInt(pos.solSpent);
    const pnlPercent  = Number(pnlLamports) / Number(pos.solSpent) * 100;

    const record = {
      ...pos,
      closedAt:    Date.now(),
      solReceived: result.solReceived,
      reason:      result.reason,
      txSig:       result.txSig ?? null,
      pnlLamports,
      pnlPercent,
    };
    this._closed.push(record);
    return record;
  }

  /** Running P&L summary across all closed positions. */
  pnlSummary() {
    const wins   = this._closed.filter(p => p.pnlLamports > 0n);
    const losses = this._closed.filter(p => p.pnlLamports <= 0n);
    const totalPnl = this._closed.reduce((s, p) => s + p.pnlLamports, 0n);
    return {
      totalTrades: this._closed.length,
      wins:        wins.length,
      losses:      losses.length,
      totalPnlLamports: totalPnl,
      totalPnlSol: Number(totalPnl) / 1e9,
    };
  }
}

module.exports = { PositionTracker };
