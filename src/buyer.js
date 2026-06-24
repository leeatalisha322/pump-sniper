'use strict';

// Builds and sends pump.fun buy / sell transactions.
// Instruction layout derived from the official pump.json IDL.

const {
  Connection, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, SystemProgram, SYSVAR_RENT_PUBKEY,
  sendAndConfirmTransaction, Keypair,
} = require('@solana/web3.js');

const {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
} = require('@solana/spl-token');

const { BC_IX, AMM_IX } = require('pump-laserstream-parser');

// ─── Known on-chain addresses ──────────────────────────────────────────────────

const PUMP_PROGRAM    = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const SYSTEM_PROGRAM  = SystemProgram.programId;
const RENT_SYSVAR     = SYSVAR_RENT_PUBKEY;

// Stable PDAs derived from the pump program
const [GLOBAL_PDA]           = PublicKey.findProgramAddressSync([Buffer.from('global')], PUMP_PROGRAM);
const [EVENT_AUTHORITY_PDA]  = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_PROGRAM);

// Global account layout: disc(8) + initialized(1) + authority(32) + fee_recipient(32) + ...
const FEE_RECIPIENT_OFFSET = 8 + 1 + 32;

class Buyer {
  /**
   * @param {object} opts
   * @param {Connection} opts.connection
   * @param {Keypair}    opts.wallet
   * @param {number}     opts.priorityFeeMicroLamports
   * @param {number}     opts.slippageBps
   * @param {string}     opts.commitment
   */
  constructor(opts) {
    this._conn     = opts.connection;
    this._wallet   = opts.wallet;
    this._priority = opts.priorityFeeMicroLamports ?? 100_000;
    this._slippage = opts.slippageBps ?? 300;    // 3% default
    this._commit   = opts.commitment ?? 'confirmed';
    this._feeRecipient = null;
  }

  // ── Setup ──────────────────────────────────────────────────────────────────

  /**
   * Fetch the fee_recipient from the on-chain global account.
   * Must be called once before first buy.
   */
  async fetchFeeRecipient() {
    const info = await this._conn.getAccountInfo(GLOBAL_PDA);
    if (!info) throw new Error('pump.fun global account not found');
    const feeBytes = info.data.slice(FEE_RECIPIENT_OFFSET, FEE_RECIPIENT_OFFSET + 32);
    this._feeRecipient = new PublicKey(feeBytes);
    return this._feeRecipient;
  }

  // ── Buy ────────────────────────────────────────────────────────────────────

  /**
   * Buy tokens on the bonding curve.
   *
   * @param {object} params
   * @param {string} params.mint          - base58 mint address
   * @param {string} params.bondingCurve  - base58 bonding curve PDA (from create event)
   * @param {bigint} params.tokenAmount   - expected token amount out (raw units, 6 dec)
   * @param {bigint} params.solSpend      - lamports to spend (before slippage)
   * @returns {{ signature: string, tokenAmount: bigint, solSpent: bigint }}
   */
  async buy({ mint, bondingCurve, tokenAmount, solSpend }) {
    if (!this._feeRecipient) await this.fetchFeeRecipient();

    const mintPk  = new PublicKey(mint);
    const bcPk    = new PublicKey(bondingCurve);
    const userPk  = this._wallet.publicKey;

    const assocBc   = getAssociatedTokenAddressSync(mintPk, bcPk, true);
    const assocUser = getAssociatedTokenAddressSync(mintPk, userPk);

    // max_sol_cost = spend + slippage
    const maxSolCost = solSpend + (solSpend * BigInt(this._slippage) / 10_000n);

    const ix = new TransactionInstruction({
      programId: PUMP_PROGRAM,
      keys: [
        { pubkey: GLOBAL_PDA,             isSigner: false, isWritable: false },
        { pubkey: this._feeRecipient,     isSigner: false, isWritable: true  },
        { pubkey: mintPk,                 isSigner: false, isWritable: false },
        { pubkey: bcPk,                   isSigner: false, isWritable: true  },
        { pubkey: assocBc,                isSigner: false, isWritable: true  },
        { pubkey: assocUser,              isSigner: false, isWritable: true  },
        { pubkey: userPk,                 isSigner: true,  isWritable: true  },
        { pubkey: SYSTEM_PROGRAM,         isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID,       isSigner: false, isWritable: false },
        { pubkey: RENT_SYSVAR,            isSigner: false, isWritable: false },
        { pubkey: EVENT_AUTHORITY_PDA,    isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM,           isSigner: false, isWritable: false },
      ],
      data: this._encodeBuyArgs(tokenAmount, maxSolCost),
    });

    const tx = new Transaction();
    tx.add(...this._priorityIxs());
    // Create the user's token account if needed (idempotent — safe to always include)
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      userPk, assocUser, userPk, mintPk,
    ));
    tx.add(ix);

    const signature = await sendAndConfirmTransaction(this._conn, tx, [this._wallet], {
      commitment: this._commit,
    });

    return { signature, tokenAmount, solSpent: maxSolCost };
  }

  // ── Sell ───────────────────────────────────────────────────────────────────

  /**
   * Sell tokens on the bonding curve.
   *
   * @param {object} params
   * @param {string} params.mint
   * @param {string} params.bondingCurve
   * @param {bigint} params.tokenAmount   - raw token units to sell
   * @param {bigint} params.minSolOut     - minimum lamports to accept (0 = no floor)
   * @returns {{ signature: string, solReceived: bigint }}
   */
  async sell({ mint, bondingCurve, tokenAmount, minSolOut = 0n }) {
    if (!this._feeRecipient) await this.fetchFeeRecipient();

    const mintPk  = new PublicKey(mint);
    const bcPk    = new PublicKey(bondingCurve);
    const userPk  = this._wallet.publicKey;

    const assocBc   = getAssociatedTokenAddressSync(mintPk, bcPk, true);
    const assocUser = getAssociatedTokenAddressSync(mintPk, userPk);

    // Apply slippage to min_sol_output
    const minOut = minSolOut > 0n
      ? minSolOut - (minSolOut * BigInt(this._slippage) / 10_000n)
      : 0n;

    const ix = new TransactionInstruction({
      programId: PUMP_PROGRAM,
      keys: [
        { pubkey: GLOBAL_PDA,             isSigner: false, isWritable: false },
        { pubkey: this._feeRecipient,     isSigner: false, isWritable: true  },
        { pubkey: mintPk,                 isSigner: false, isWritable: false },
        { pubkey: bcPk,                   isSigner: false, isWritable: true  },
        { pubkey: assocBc,                isSigner: false, isWritable: true  },
        { pubkey: assocUser,              isSigner: false, isWritable: true  },
        { pubkey: userPk,                 isSigner: true,  isWritable: true  },
        { pubkey: SYSTEM_PROGRAM,         isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID,       isSigner: false, isWritable: false },
        { pubkey: EVENT_AUTHORITY_PDA,    isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM,           isSigner: false, isWritable: false },
      ],
      data: this._encodeSellArgs(tokenAmount, minOut),
    });

    const tx = new Transaction();
    tx.add(...this._priorityIxs());
    tx.add(ix);

    const signature = await sendAndConfirmTransaction(this._conn, tx, [this._wallet], {
      commitment: this._commit,
    });

    // Estimate sol received from balance change (approximate — actual value
    // is available in the transaction meta but would need an RPC fetch)
    return { signature, solReceived: minOut };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _priorityIxs() {
    return [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this._priority }),
    ];
  }

  _encodeBuyArgs(tokenAmount, maxSolCost) {
    const buf = Buffer.alloc(24);
    BC_IX.buy.copy(buf, 0);
    buf.writeBigUInt64LE(BigInt(tokenAmount), 8);
    buf.writeBigUInt64LE(BigInt(maxSolCost), 16);
    return buf;
  }

  _encodeSellArgs(tokenAmount, minSolOutput) {
    const buf = Buffer.alloc(24);
    BC_IX.sell.copy(buf, 0);
    buf.writeBigUInt64LE(BigInt(tokenAmount), 8);
    buf.writeBigUInt64LE(BigInt(minSolOutput), 16);
    return buf;
  }

  /**
   * Fetch the current token balance for the bot's wallet.
   *
   * @param {string} mint
   * @returns {bigint} raw token units
   */
  async getTokenBalance(mint) {
    try {
      const ata = getAssociatedTokenAddressSync(new PublicKey(mint), this._wallet.publicKey);
      const acc = await getAccount(this._conn, ata);
      return acc.amount;
    } catch {
      return 0n;
    }
  }
}

module.exports = { Buyer, GLOBAL_PDA, EVENT_AUTHORITY_PDA };
