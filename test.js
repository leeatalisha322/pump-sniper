'use strict';

// Unit tests — no network, no wallet required.
// Tests cover CreatorFilter, PositionTracker, and Buyer instruction encoding.

const { CreatorFilter }   = require('./src/filter');
const { PositionTracker } = require('./src/positions');
const { BC_IX }           = require('pump-laserstream-parser');

let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); passed++; }
  else       { console.error(`  ✗ ${msg}`); failed++; }
}

// ─── 1. CreatorFilter ─────────────────────────────────────────────────────────

console.log('\n1. CreatorFilter — open mode (no whitelist)');
{
  const f = new CreatorFilter({ blacklist: ['BadActor111'] });
  assert(f.isAllowed('GoodCreator111'),   'allows unknown creator in open mode');
  assert(!f.isAllowed('BadActor111'),     'blocks blacklisted creator');
  assert(!f.isAllowed(null),              'rejects null');
  assert(!f.isAllowed(''),               'rejects empty string');
}

console.log('\n2. CreatorFilter — whitelist mode');
{
  const f = new CreatorFilter({
    whitelist: ['Alpha111', 'Beta222'],
    blacklist: ['Gamma333'],
  });
  assert(f.isAllowed('Alpha111'),         'allows whitelisted Alpha');
  assert(f.isAllowed('Beta222'),          'allows whitelisted Beta');
  assert(!f.isAllowed('Delta444'),        'blocks unknown in whitelist mode');
  assert(!f.isAllowed('Gamma333'),        'blocks blacklisted even if not in whitelist');

  f.allow('Delta444');
  assert(f.isAllowed('Delta444'),         'allow() adds to whitelist at runtime');

  f.block('Alpha111');
  assert(!f.isAllowed('Alpha111'),        'block() removes from whitelist + adds blacklist');

  f.unallow('Beta222');
  assert(!f.isAllowed('Beta222'),         'unallow() removes from whitelist');

  const s = f.summary();
  assert(s.mode === 'whitelist',          'summary mode = whitelist');
  assert(typeof s.whitelistSize === 'number', 'summary has whitelistSize');
}

// ─── 3. PositionTracker ───────────────────────────────────────────────────────

console.log('\n3. PositionTracker — open / close');
{
  const pt = new PositionTracker({ takeProfitPercent: 100, stopLossPercent: 30, maxOpenPositions: 2 });

  assert(!pt.isFull(),                   'not full initially');
  assert(pt.count() === 0,               'count 0');

  const mint1 = 'Mint1111111111111111111111111111';
  pt.open(mint1, {
    solSpent:        100_000_000n,      // 0.1 SOL
    tokenAmount:     1_000_000_000n,
    entrySolPerToken: 100n,             // entry price
    creator: 'Creator111', name: 'TestCoin', symbol: 'TC',
  });

  assert(pt.count() === 1,              'count 1 after open');
  assert(pt.has(mint1),                 'has mint1');

  // Price unchanged — no exit
  const { shouldSell: noSell } = pt.checkExit(mint1, 100n);
  assert(!noSell,                       'no exit at entry price');

  // Price 2x — take profit
  const { shouldSell: tp, reason: tpR } = pt.checkExit(mint1, 200n);
  assert(tp,                            'take profit triggered at 2x');
  assert(tpR.includes('take_profit'),   'reason contains take_profit');

  // Price -35% — stop loss
  const { shouldSell: sl, reason: slR } = pt.checkExit(mint1, 65n);
  assert(sl,                            'stop loss triggered at -35%');
  assert(slR.includes('stop_loss'),     'reason contains stop_loss');

  // Open second position — now full
  const mint2 = 'Mint2222222222222222222222222222';
  pt.open(mint2, { solSpent: 50_000_000n, tokenAmount: 500_000_000n, entrySolPerToken: 100n, creator: 'C2' });
  assert(pt.isFull(),                   'full at max 2');

  // Close first position
  const closed = pt.close(mint1, { solReceived: 150_000_000n, reason: 'take_profit' });
  assert(closed !== null,               'close returns record');
  assert(closed.pnlLamports === 50_000_000n, 'pnlLamports correct');
  assert(closed.pnlPercent > 0,         'pnlPercent positive');
  assert(pt.count() === 1,              'count 1 after close');
  assert(!pt.isFull(),                  'no longer full');

  // P&L summary
  const pnl = pt.pnlSummary();
  assert(pnl.totalTrades === 1,         'totalTrades 1');
  assert(pnl.wins === 1,                'wins 1');
  assert(pnl.totalPnlSol > 0,           'totalPnlSol positive');
}

// ─── 4. PositionTracker — unknown mint ───────────────────────────────────────

console.log('\n4. PositionTracker — unknown mint');
{
  const pt = new PositionTracker({});
  const { shouldSell } = pt.checkExit('UnknownMint111', 200n);
  assert(!shouldSell,                   'no exit for unknown mint');

  const closed = pt.close('UnknownMint111', { solReceived: 0n, reason: 'manual' });
  assert(closed === null,               'close returns null for unknown mint');
}

// ─── 5. Buy instruction encoding ─────────────────────────────────────────────

console.log('\n5. Buy instruction encoding');
{
  // Mirror the _encodeBuyArgs logic from buyer.js without requiring @solana deps
  function encodeBuyArgs(tokenAmount, maxSolCost) {
    const buf = Buffer.alloc(24);
    BC_IX.buy.copy(buf, 0);
    buf.writeBigUInt64LE(BigInt(tokenAmount), 8);
    buf.writeBigUInt64LE(BigInt(maxSolCost), 16);
    return buf;
  }

  const data = encodeBuyArgs(1_250_000_000n, 52_000_000n);
  assert(data.length === 24,                      'buy data is 24 bytes');
  assert(data.slice(0, 8).equals(BC_IX.buy),      'discriminator matches BC_IX.buy');
  assert(data.readBigUInt64LE(8)  === 1_250_000_000n, 'token amount encoded');
  assert(data.readBigUInt64LE(16) === 52_000_000n,    'max_sol_cost encoded');
}

console.log('\n6. Sell instruction encoding');
{
  function encodeSellArgs(tokenAmount, minSolOutput) {
    const buf = Buffer.alloc(24);
    BC_IX.sell.copy(buf, 0);
    buf.writeBigUInt64LE(BigInt(tokenAmount), 8);
    buf.writeBigUInt64LE(BigInt(minSolOutput), 16);
    return buf;
  }

  const data = encodeSellArgs(500_000_000n, 40_000_000n);
  assert(data.length === 24,                      'sell data is 24 bytes');
  assert(data.slice(0, 8).equals(BC_IX.sell),     'discriminator matches BC_IX.sell');
  assert(data.readBigUInt64LE(8)  === 500_000_000n,  'token amount encoded');
  assert(data.readBigUInt64LE(16) === 40_000_000n,   'min_sol_output encoded');
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
