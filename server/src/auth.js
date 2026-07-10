// Authentication + rate limiting for the SafeWeb server.
//
// Two authenticated principals:
//   * Devices — send `Authorization: Bearer <deviceToken>`. We hash the token
//     with the server pepper and look the device up by hash. The plaintext
//     token is never stored.
//   * Partners — hold an opaque `sw_session` cookie mapping to an in-memory
//     session. (A production build would persist sessions; in-memory is fine
//     for a single-node self-hosted deployment.)

import { hashToken, generateSessionId } from '../../shared/crypto.js';

export function createAuth({ db, pepper }) {
  /** @type {Map<string,{partnerId:string, createdTs:number}>} */
  const sessions = new Map();

  return {
    // ---- device auth ----------------------------------------------------
    /**
     * Resolve the device for a request, or null. Accepts the raw
     * Authorization header value.
     */
    deviceFromAuthHeader(authHeader) {
      if (typeof authHeader !== 'string') return null;
      const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
      if (!m) return null;
      const token = m[1].trim();
      if (!token) return null;
      const device = db.getDeviceByTokenHash(hashToken(token, pepper));
      if (!device || !device.active) return null;
      return device;
    },

    // ---- partner sessions ----------------------------------------------
    createSession(partnerId) {
      const sid = generateSessionId();
      sessions.set(sid, { partnerId, createdTs: Date.now() });
      return sid;
    },
    partnerFromSession(sid) {
      if (!sid) return null;
      const s = sessions.get(sid);
      if (!s) return null;
      return db.getPartnerById(s.partnerId);
    },
    destroySession(sid) {
      if (sid) sessions.delete(sid);
    },
  };
}

/**
 * A minimal fixed-window in-memory rate limiter. `key` groups attempts
 * (e.g. `login:<ip>`). Returns true if the attempt is allowed.
 */
export function createRateLimiter({ windowMs = 60_000, max = 10 } = {}) {
  /** @type {Map<string,{count:number, resetTs:number}>} */
  const buckets = new Map();
  return {
    allow(key) {
      const now = Date.now();
      const b = buckets.get(key);
      if (!b || b.resetTs < now) {
        buckets.set(key, { count: 1, resetTs: now + windowMs });
        return true;
      }
      if (b.count >= max) return false;
      b.count += 1;
      return true;
    },
    reset(key) {
      buckets.delete(key);
    },
  };
}
