import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

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

// --- Login throttling: per IP, per account+IP and per account. The per-account cap stops distributed
// guessing, but it is skipped for a browser that has already signed in to that account successfully
// (a "trusted device" cookie), so attackers cannot lock the real owner out by failing on purpose.
export function createLoginLimiter({ windowMs = 15 * 60 * 1000, perIp = 30, perAccountIp = 10, perAccount = 50, maxEntries = 20000 } = {}) {
  const buckets = new Map();
  const now = () => Date.now();
  const read = key => { const item = buckets.get(key); if (item && item.until > now()) return item; buckets.delete(key); return null; };
  const sweep = () => {
    if (buckets.size < maxEntries) return;
    for (const [key, item] of buckets) if (item.until <= now()) buckets.delete(key);
    while (buckets.size >= maxEntries) buckets.delete(buckets.keys().next().value);
  };
  const keys = (ip, account) => [[`ip:${ip}`, perIp], [`pair:${ip}:${account}`, perAccountIp], [`acct:${account}`, perAccount]];
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
      for (const [key] of keys(ip, account)) { const item = read(key); buckets.set(key, { count: (item?.count || 0) + 1, until: item?.until || now() + windowMs }); }
    },
    success(ip, account) { buckets.delete(`pair:${ip}:${account}`); },
    clear() { buckets.clear(); }
  };
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
