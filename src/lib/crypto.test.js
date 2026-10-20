import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { encryptField, decryptField } from './crypto.js';
import { encryptRecord, decryptRecord, encryptJsonField, decryptJsonField } from './cryptoRecord.js';

const rawKey = Buffer.from('0123456789abcdef0123456789abcdef');
const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']);

// Build the stored format independently of the app: IV + ciphertext + GCM tag.
function storedField(plaintext) {
  const iv = Buffer.from('000102030405060708090a0b', 'hex');
  const cipher = createCipheriv('aes-256-gcm', rawKey, iv);
  return Buffer.concat([iv, cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
}

test('decrypts existing unprefixed AES-GCM fields, including Unicode', async () => {
  const plaintext = 'Calendar 🔒 — meeting at 9:00';
  assert.equal(await decryptField(key, storedField(plaintext)), plaintext);
});

test('new fields keep the stored format and use a fresh IV', async () => {
  const first = await encryptField(key, 'Meeting');
  const second = await encryptField(key, 'Meeting');
  assert.notEqual(first, second);
  const bytes = Buffer.from(first, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', rawKey, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  assert.equal(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8'), 'Meeting');
});

test('keeps plaintext and empty values; rejects a wrong key or damaged data', async () => {
  for (const value of [null, undefined, '', 'Legacy plaintext with spaces']) {
    assert.equal(await decryptField(key, value), value);
  }
  const wrongKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const blob = storedField('Private event');
  assert.equal(await decryptField(wrongKey, blob), null);
  const damaged = Buffer.from(blob, 'base64');
  damaged[12] ^= 1;
  assert.equal(await decryptField(key, damaged.toString('base64')), null);
});

test('record and JSON encryption preserve existing field compatibility', async () => {
  const existing = { id: 'event-1', label: storedField('Existing event'), notes: 'Legacy notes with spaces' };
  assert.deepEqual(await decryptRecord(key, existing, ['label', 'notes']), {
    id: 'event-1', label: 'Existing event', notes: 'Legacy notes with spaces',
  });
  const record = { id: 'event-2', label: 'New event', notes: '', count: 2 };
  assert.deepEqual(await decryptRecord(key, await encryptRecord(key, record, ['label', 'notes']), ['label', 'notes']), record);
  const people = [{ name: 'Alex', email: 'alex@example.com' }];
  assert.deepEqual(await decryptJsonField(key, storedField(JSON.stringify(people))), people);
  assert.deepEqual(await decryptJsonField(key, await encryptJsonField(key, people)), people);
});
