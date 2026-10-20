/**
 * Zero-knowledge envelope encryption (Model B — the server never sees the
 * password). All crypto runs in the browser via Web Crypto (SubtleCrypto).
 *
 * The model
 * ─────────
 * Two things are derived from the password, with DIFFERENT salts:
 *   • authVerifier  — the ONLY value sent to the server to authenticate.
 *                     The server stores bcrypt(authVerifier); it can't reverse
 *                     it to the password and never learns the password.
 *   • KEK           — a key-encryption key that never leaves the browser.
 *
 * A random per-user DEK (data-encryption key) actually encrypts the user's
 * fields. The DEK is wrapped (encrypted) twice so either secret can recover it:
 *   • wrappedDekPassword  — DEK wrapped under the password-derived KEK
 *   • wrappedDekRecovery  — DEK wrapped under a recovery-code-derived key
 *
 * "Reset password without losing data" works because the recovery code can
 * unwrap the DEK, then we re-wrap it under a new password.
 *
 * Wrong password / recovery code → AES-GCM authentication fails on unwrap, so
 * the unlock throws rather than returning a bogus key. No separate verifier
 * blob is needed.
 */

const PBKDF2_ITERS = 600_000;
const SALT_BYTES   = 16;
const IV_BYTES     = 12;
const PREFIX       = 'zk1:';      // marks wrapped-DEK blobs

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

// ── base64 helpers (work in browser + Node) ──────────────────────────────────
function toB64(bytes) {
  let bin = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}
function fromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}
export function generateSalt() {
  return toB64(randomBytes(SALT_BYTES));
}

// ── key derivation ───────────────────────────────────────────────────────────
async function importPbkdf2Base(secret) {
  return subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits', 'deriveKey']);
}

/**
 * Auth verifier: a deterministic 256-bit value (hex) derived from the password.
 * This is what the server bcrypts. Salt is distinct from the KEK salt so the
 * verifier reveals nothing about the wrapping key.
 */
export async function deriveAuthVerifier(password, authSaltB64) {
  const base = await importPbkdf2Base(password);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: fromB64(authSaltB64), iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    base, 256,
  );
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Derive an AES-GCM wrapping key (used for both the password KEK and the recovery key). */
async function deriveWrappingKey(secret, saltB64) {
  const base = await importPbkdf2Base(secret);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: fromB64(saltB64), iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ── DEK lifecycle ────────────────────────────────────────────────────────────
/** New random data-encryption key. Extractable so it can be wrapped. */
export async function generateDEK() {
  return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/** Wrap (encrypt) the DEK's raw bytes under a wrapping key → portable blob string. */
async function wrapDEK(dek, wrappingKey) {
  const raw = await subtle.exportKey('raw', dek);
  const iv = randomBytes(IV_BYTES);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, raw);
  return PREFIX + toB64(new Uint8Array([...iv, ...new Uint8Array(ct)]));
}

/** Unwrap a blob back into a DEK CryptoKey. Throws if the wrapping key is wrong. */
async function unwrapDEK(blob, wrappingKey) {
  if (typeof blob !== 'string' || !blob.startsWith(PREFIX)) throw new Error('Bad wrapped-DEK format.');
  const data = fromB64(blob.slice(PREFIX.length));
  const iv = data.subarray(0, IV_BYTES);
  const ct = data.subarray(IV_BYTES);
  const raw = await subtle.decrypt({ name: 'AES-GCM', iv }, wrappingKey, ct);
  return subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

// ── recovery code ────────────────────────────────────────────────────────────
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Crockford-ish, no ambiguous chars

/** Human-friendly one-time recovery code, e.g. "K7P2-9QFM-3WXR-T8YN-J5HC". */
export function generateRecoveryCode() {
  const bytes = randomBytes(20);
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    if (i > 0 && i % 4 === 0) s += '-';
    s += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
  }
  return s;
}

/** Normalize user-typed recovery codes (strip spaces/dashes, uppercase) before deriving. */
export function normalizeRecoveryCode(code) {
  return String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ── envelope assembly ────────────────────────────────────────────────────────
/**
 * Build a fresh envelope for a new account.
 * Returns the server-storable envelope fields, the one-time recoveryCode to
 * show the user, and the live `dek` (so the just-registered session is already
 * unlocked without re-deriving).
 */
export async function createEnvelope(password) {
  const authSalt     = generateSalt();
  const kdfSalt      = generateSalt();
  const recoverySalt = generateSalt();
  const recoveryCode = generateRecoveryCode();

  // Separate salt for the recovery *verifier* so it can't equal the recovery
  // *wrapping key* (same input + same salt would derive identical bits, leaking
  // the wrapping key to the server).
  const recoveryAuthSalt = generateSalt();
  const normCode = normalizeRecoveryCode(recoveryCode);

  const dek = await generateDEK();
  const kek         = await deriveWrappingKey(password, kdfSalt);
  const recoveryKey = await deriveWrappingKey(normCode, recoverySalt);

  return {
    authVerifier:       await deriveAuthVerifier(password, authSalt),
    authSalt, kdfSalt,
    recoverySalt, recoveryAuthSalt,
    recoveryVerifier:   await deriveAuthVerifier(normCode, recoveryAuthSalt),
    wrappedDekPassword: await wrapDEK(dek, kek),
    wrappedDekRecovery: await wrapDEK(dek, recoveryKey),
    recoveryCode,
    dek,
  };
}

/**
 * Proof a reset requester holds the recovery code. The server compares
 * bcrypt(this) against the stored recovery verifier before accepting a new
 * password envelope.
 */
export async function deriveRecoveryVerifier(recoveryCode, recoveryAuthSaltB64) {
  return deriveAuthVerifier(normalizeRecoveryCode(recoveryCode), recoveryAuthSaltB64);
}

/** Unwrap the DEK using the password. Throws on wrong password. */
export async function unlockWithPassword(envelope, password) {
  const kek = await deriveWrappingKey(password, envelope.kdfSalt);
  return unwrapDEK(envelope.wrappedDekPassword, kek);
}

/** Unwrap the DEK using the recovery code. Throws on wrong code. */
export async function unlockWithRecovery(envelope, recoveryCode) {
  const key = await deriveWrappingKey(normalizeRecoveryCode(recoveryCode), envelope.recoverySalt);
  return unwrapDEK(envelope.wrappedDekRecovery, key);
}

/**
 * Re-wrap an already-unwrapped DEK under a NEW password (password change /
 * recovery-based reset). Returns the fields the server must persist. The
 * recovery wrapping is untouched.
 */
export async function rewrapForPassword(dek, newPassword) {
  const authSalt = generateSalt();
  const kdfSalt  = generateSalt();
  const kek = await deriveWrappingKey(newPassword, kdfSalt);
  return {
    authVerifier:       await deriveAuthVerifier(newPassword, authSalt),
    authSalt, kdfSalt,
    wrappedDekPassword: await wrapDEK(dek, kek),
  };
}

// ── Google linked-login wrap ──────────────────────────────────────────────────
/**
 * Wrap the DEK under a fresh random 256-bit secret for the "Sign in with Google"
 * door. Unlike the password/recovery wraps, the secret is already high-entropy,
 * so it's used directly as the AES-GCM key (no PBKDF2 stretching needed).
 *
 * Returns the wrapped blob to store on the envelope and the raw secret (base64).
 * The caller sends BOTH to the server: the server holds the secret and releases
 * it only after a verified Google sign-in. This is the one server-assisted path
 * — password + recovery unwrapping never leave the browser.
 */
export async function wrapDekForGoogle(dek) {
  const secret = randomBytes(32);
  const key = await subtle.importKey('raw', secret, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { wrappedDekGoogle: await wrapDEK(dek, key), googleUnlockSecret: toB64(secret) };
}

/** Unwrap the DEK using the server-released Google secret. Throws if it's wrong. */
export async function unlockWithGoogle(wrappedDekGoogle, googleUnlockSecretB64) {
  const key = await subtle.importKey('raw', fromB64(googleUnlockSecretB64), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return unwrapDEK(wrappedDekGoogle, key);
}

// ── DEK session persistence ──────────────────────────────────────────────────
// For "stay unlocked on this device": export the raw DEK to stash in
// sessionStorage and re-import it after a reload. sessionStorage is per-tab and
// cleared when the tab closes, so the key never touches disk.
export async function exportDek(dek) {
  return toB64(await subtle.exportKey('raw', dek));
}
export async function importDek(b64) {
  return subtle.importKey('raw', fromB64(b64), { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
