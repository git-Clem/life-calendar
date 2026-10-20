/**
 * Zero-knowledge encryption helpers — React Native edition.
 *
 * Mirrors src/lib/crypto.js field encryption on the web exactly
 * (AES-256-GCM, blob = base64(iv + ciphertext + tag)) so the active
 * data-encryption key decrypts data written by either platform.
 * Uses the audited pure-JS @noble libraries since React Native has no
 * SubtleCrypto.
 */
import 'react-native-get-random-values';
import { randomBytes } from '@noble/hashes/utils.js';
import { gcm } from '@noble/ciphers/aes.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Shown in place of a field whose decryption failed, instead of garbled base64. */
export const DECRYPT_FAILURE_PLACEHOLDER = "🔒 couldn't decrypt";

// ── Field encryption / decryption ─────────────────────────────────────────────

/** Encrypt a plaintext string. Returns base64(iv + ciphertext + tag). */
export async function encryptField(masterKey, plaintext) {
  if (!plaintext) return plaintext;
  const iv = randomBytes(12);
  const ciphertext = gcm(masterKey, iv).encrypt(enc.encode(plaintext));
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return bytesToBase64(combined);
}

/**
 * Decrypt an encrypted field. Returns the original plaintext string,
 * or `null` if the key is wrong or the ciphertext is malformed — never
 * the raw ciphertext, so callers can't mistake garbled base64 for real data.
 * Returns the raw value unchanged only when it isn't a valid blob at all
 * (legacy plaintext rows) — same semantics as the web.
 */
export async function decryptField(masterKey, ciphertext) {
  if (!ciphertext) return ciphertext;
  if (!isBase64(ciphertext)) return ciphertext;
  try {
    const combined = base64ToBytes(ciphertext);
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    return dec.decode(gcm(masterKey, iv).decrypt(data));
  } catch {
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += B64_CHARS[b0 >> 2];
    out += B64_CHARS[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? '=' : B64_CHARS[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? '=' : B64_CHARS[b2 & 63];
  }
  return out;
}

function base64ToBytes(b64) {
  const clean = b64.replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64_CHARS.indexOf(clean[i]) << 18)
            | (B64_CHARS.indexOf(clean[i + 1]) << 12)
            | ((B64_CHARS.indexOf(clean[i + 2]) & 63) << 6)
            | (B64_CHARS.indexOf(clean[i + 3]) & 63);
    bytes[o++] = (n >> 16) & 255;
    if (clean[i + 2] !== undefined) bytes[o++] = (n >> 8) & 255;
    if (clean[i + 3] !== undefined) bytes[o++] = n & 255;
  }
  return bytes;
}

function isBase64(str) {
  if (typeof str !== 'string' || str.length < 16) return false;
  return /^[A-Za-z0-9+/]+=*$/.test(str);
}
