/**
 * Zero-knowledge encryption helpers.
 * Uses the browser's native SubtleCrypto API — zero external dependencies.
 * AES-256-GCM field encryption using the active data-encryption key.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Shown in place of a field whose decryption failed, instead of garbled base64. */
export const DECRYPT_FAILURE_PLACEHOLDER = "🔒 couldn't decrypt";

// ── Field encryption / decryption ─────────────────────────────────────────────

/**
 * Encrypt a plaintext string. Returns base64(iv + ciphertext + tag).
 * Each call uses a fresh random IV.
 */
export async function encryptField(masterKey, plaintext) {
  if (!plaintext) return plaintext;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    masterKey,
    enc.encode(plaintext)
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return bytesToBase64(combined);
}

/**
 * Decrypt an encrypted field. Returns the original plaintext string,
 * or `null` if the key is wrong or the ciphertext is malformed — never
 * the raw ciphertext, so callers can't mistake garbled base64 for real data.
 */
export async function decryptField(masterKey, ciphertext) {
  if (!ciphertext) return ciphertext;
  // If not base64-encoded (e.g. legacy plaintext), return as-is
  if (!isBase64(ciphertext)) return ciphertext;
  try {
    const combined = base64ToBytes(ciphertext);
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, masterKey, data);
    return dec.decode(plaintext);
  } catch {
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

export function isBase64(str) {
  if (typeof str !== 'string' || str.length < 16) return false;
  return /^[A-Za-z0-9+/]+=*$/.test(str);
}
