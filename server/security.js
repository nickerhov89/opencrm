import { createHmac, timingSafeEqual, randomBytes, scrypt } from 'node:crypto';
import { isIP } from 'node:net';

export const permissionEntities = ['deal', 'contact', 'company', 'task'];
export const permissionActions = ['create', 'edit', 'delete', 'export'];

const matrix = fill => Object.fromEntries(permissionEntities.map(entity => [entity, Object.fromEntries(permissionActions.map(action => [action, fill(entity, action)]))]));
export const noPermissions = () => matrix(() => false);
export const fullPermissions = () => matrix((entity, action) => !(entity === 'task' && action === 'export'));
// New members can work with records, but deleting and bulk export must be granted explicitly.
export const defaultMemberPermissions = () => matrix((_entity, action) => action === 'create' || action === 'edit');

export function normalizePermissions(input, base = noPermissions()) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return matrix((entity, action) => {
    const raw = source[entity]?.[action];
    return typeof raw === 'boolean' ? raw : base[entity][action];
  });
}

export const securityHeaders = (res, { https = false } = {}) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'DENY');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  if (https) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
};

// The address a limit is counted for. An IPv6 client usually owns a whole /64, so every address in it
// shares one bucket; IPv4-mapped IPv6 (::ffff:1.2.3.4) counts as the IPv4 address.
export function ipBucket(raw) {
  const ip = String(raw || '').trim().toLowerCase().replace(/%.*$/, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) return mapped[1];
  if (isIP(ip) !== 6) return ip.slice(0, 64);
  const [head, tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [], right = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map(group => (group.includes('.') ? '0' : group).replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// --- Login throttling: per IP, per account+IP and per account, in a 5-minute window. The per-account
// cap stops distributed guessing, but it is skipped for a browser that has already signed in to that
// account successfully (a "trusted device" cookie), so attackers cannot lock the real owner out by
// failing on purpose. A flood of new entries cannot push out counters that are already at their limit.
export function createLoginLimiter({ windowMs = 5 * 60 * 1000, perIp = 30, perAccountIp = 10, perAccount = 50, maxEntries = 100000 } = {}) {
  const buckets = new Map();
  const now = () => Date.now();
  const read = key => { const item = buckets.get(key); if (item && item.until > now()) return item; buckets.delete(key); return null; };
  const sweep = () => {
    if (buckets.size < maxEntries) return;
    for (const [key, item] of buckets) if (item.until <= now()) buckets.delete(key);
    for (const [key, item] of buckets) { if (buckets.size < maxEntries) break; if (item.count < item.limit) buckets.delete(key); }
    while (buckets.size >= maxEntries) buckets.delete(buckets.keys().next().value);
  };
  const keys = (rawIp, account) => { const ip = ipBucket(rawIp); return [[`ip:${ip}`, perIp], [`pair:${ip}:${account}`, perAccountIp], [`acct:${account}`, perAccount]]; };
  return {
    blocked(ip, account, { trusted = false } = {}) {
      let retry = 0;
      for (const [key, limit] of keys(ip, account)) {
        if (trusted && key.startsWith('acct:')) continue;
        const item = read(key); if (item && item.count >= limit) retry = Math.max(retry, item.until - now());
      }
      return retry > 0 ? Math.ceil(retry / 1000) : 0;
    },
    fail(ip, account) {
      sweep();
      for (const [key, limit] of keys(ip, account)) { const item = read(key); buckets.set(key, { count: (item?.count || 0) + 1, until: item?.until || now() + windowMs, limit }); }
    },
    success(ip, account) { buckets.delete(`pair:${ipBucket(ip)}:${account}`); },
    clear() { buckets.clear(); }
  };
}

// --- Sliding-window limit of actions per key (public lead form): hit() counts the action and returns 0,
// or the seconds to wait when the key already used its limit (a refused action is not counted).
export function createRateLimiter({ windowMs, limit, maxEntries = 50000 }) {
  const hits = new Map();
  return {
    hit(key, now = Date.now()) {
      const recent = (hits.get(key) || []).filter(time => now - time < windowMs);
      if (recent.length >= limit) { hits.set(key, recent); return Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000)); }
      recent.push(now);
      hits.delete(key); hits.set(key, recent);
      if (hits.size > maxEntries) {
        for (const [other, times] of hits) if (!times.some(time => now - time < windowMs)) hits.delete(other);
        while (hits.size > maxEntries) hits.delete(hits.keys().next().value);
      }
      return 0;
    },
    clear() { hits.clear(); }
  };
}

// --- Passwords: scrypt runs in the libuv thread pool, so checking a password does not stop the server
// from answering other requests (scryptSync blocked the event loop for tens of milliseconds per login).
const scryptAsync = (password, salt) => new Promise((resolve, reject) => scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key)));
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await scryptAsync(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const computed = await scryptAsync(password, salt), saved = Buffer.from(hash, 'hex');
  return saved.length === computed.length && timingSafeEqual(saved, computed);
}

// --- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) without third-party dependencies.
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buffer) {
  let bits = 0, value = 0, output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}
export function base32Decode(text) {
  const clean = String(text || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0; const bytes = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('Неверный секрет');
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}
export const newTotpSecret = () => base32Encode(randomBytes(20));
export function totpCode(secret, counter) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 1e6).padStart(6, '0');
}
// Returns the matched time step, or null. Steps at or before lastCounter are rejected to stop replays.
export function verifyTotp(secret, code, { now = Date.now(), lastCounter = -1 } = {}) {
  if (!secret || typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return null;
  const current = Math.floor(now / 30000), wanted = Buffer.from(code.trim());
  for (const step of [current - 1, current, current + 1]) {
    if (step <= lastCounter) continue;
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), wanted)) return step;
  }
  return null;
}
export const otpauthUrl = (secret, account, issuer = 'OpenCRM') => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
