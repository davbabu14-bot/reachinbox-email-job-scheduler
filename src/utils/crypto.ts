import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 128-bit initialization vector
const AUTH_TAG_LENGTH = 16; // 128-bit authentication tag

/**
 * Returns a 32-byte Buffer derived from the ENCRYPTION_KEY environment variable.
 * If running in development and no key is provided, falls back to a deterministic development key.
 */
function getKey(): Buffer {
  const envKey = process.env.ENCRYPTION_KEY;
  if (!envKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('ENCRYPTION_KEY must be configured in production environment');
    }
    // Safe deterministic development key (32 bytes = 256 bits)
    return crypto.scryptSync('reachinbox-dev-fallback-key', 'reachinbox-salt', 32);
  }

  // If hex-encoded (64 characters)
  if (/^[0-9a-fA-F]{64}$/.test(envKey)) {
    return Buffer.from(envKey, 'hex');
  }

  if (envKey.length < 32) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes) or at least 32 characters in length');
  }

  // Derive 32-byte key from string using scrypt
  return crypto.scryptSync(envKey, 'reachinbox-salt', 32);
}

export interface EncryptedData {
  encrypted: string; // Hex representation of ciphertext + authTag
  iv: string; // Hex representation of initialization vector
}

/**
 * Encrypts plaintext using AES-256-GCM with a fresh random IV.
 * The authentication tag is appended to the ciphertext.
 */
export function encrypt(plaintext: string): EncryptedData {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encryptedBuffer = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return {
    encrypted: `${encryptedBuffer.toString('hex')}:${authTag.toString('hex')}`,
    iv: iv.toString('hex'),
  };
}

/**
 * Decrypts AES-256-GCM ciphertext using the stored IV and authenticated tag.
 */
export function decrypt(encryptedPayload: string, ivHex: string): string {
  const key = getKey();
  const [ciphertextHex, authTagHex] = encryptedPayload.split(':');

  if (!ciphertextHex || !authTagHex) {
    throw new Error('Malformed encrypted payload: expected ciphertext:authTag format');
  }

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('Invalid authentication tag length');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decryptedBuffer = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decryptedBuffer.toString('utf8');
}
