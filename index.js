'use strict';

require('dotenv').config();

const { PumpSniper }      = require('./src/sniper');
const { CreatorFilter }   = require('./src/filter');
const { PositionTracker } = require('./src/positions');
const { Buyer }           = require('./src/buyer');

// ── Entry point when run directly ─────────────────────────────────────────────

if (require.main === module) {
  const sniper = new PumpSniper();

  process.on('SIGINT',  () => sniper.stop().then(() => process.exit(0)));
  process.on('SIGTERM', () => sniper.stop().then(() => process.exit(0)));

  sniper.start().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}

// ── Library exports ────────────────────────────────────────────────────────────

module.exports = { PumpSniper, CreatorFilter, PositionTracker, Buyer };
