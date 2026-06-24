'use strict';

/**
 * CreatorFilter
 *
 * Controls which token creators the sniper acts on.
 *
 *  - If CREATOR_WHITELIST is non-empty, only those creators trigger a buy.
 *  - CREATOR_BLACKLIST is always checked; matching creators are always skipped.
 *  - With an empty whitelist the bot acts on every new token except blacklisted ones.
 */
class CreatorFilter {
  /**
   * @param {object} opts
   * @param {string[]} [opts.whitelist=[]]  - base58 creator addresses to allow
   * @param {string[]} [opts.blacklist=[]]  - base58 creator addresses to always skip
   */
  constructor({ whitelist = [], blacklist = [] } = {}) {
    this._whitelist = new Set(whitelist.map(a => a.trim()).filter(Boolean));
    this._blacklist = new Set(blacklist.map(a => a.trim()).filter(Boolean));
  }

  /**
   * Returns true if a buy should be attempted for this creator.
   *
   * @param {string} creator - base58 address
   * @returns {boolean}
   */
  isAllowed(creator) {
    if (!creator) return false;
    if (this._blacklist.has(creator)) return false;
    if (this._whitelist.size > 0) return this._whitelist.has(creator);
    return true;
  }

  /** Add a creator to the whitelist at runtime. */
  allow(creator) {
    this._whitelist.add(creator.trim());
  }

  /** Remove a creator from the whitelist. */
  unallow(creator) {
    this._whitelist.delete(creator.trim());
  }

  /** Add a creator to the blacklist at runtime. */
  block(creator) {
    this._blacklist.add(creator.trim());
    this._whitelist.delete(creator.trim());
  }

  /** Current filter state (for logging). */
  summary() {
    return {
      mode:           this._whitelist.size > 0 ? 'whitelist' : 'open',
      whitelistSize:  this._whitelist.size,
      blacklistSize:  this._blacklist.size,
      whitelist:      [...this._whitelist],
      blacklist:      [...this._blacklist],
    };
  }
}

module.exports = { CreatorFilter };
