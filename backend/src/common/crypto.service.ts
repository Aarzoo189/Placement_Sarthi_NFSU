import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { hash as argonHash, verify as argonVerify, Algorithm } from '@node-rs/argon2';
import { env } from '../config/env';

const DATA_KEY = Buffer.from(env.DATA_KEY, 'base64');
const HMAC_KEY = Buffer.from(env.HMAC_KEY, 'base64');
const KEY_VERSION = 'v1';

/**
 * Column-level encryption (AES-256-GCM), password hashing (Argon2id) and the small hashing helpers used elsewhere.
 *
 * Ciphertext format: `v1.<iv>.<tag>.<ciphertext>` (base64url). The version prefix is what makes key rotation possible:
 * a new key gets a new prefix and old rows are re-wrapped lazily. `aad` binds a ciphertext to its column, so a value
 * copied from `ctc_enc` into `mobile_enc` fails to decrypt.
 *
 * Prototype: the key comes from the environment. In production it is fetched from Vault / a cloud KMS at boot.
 */
@Injectable()
export class CryptoService {
  encrypt(plain: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', DATA_KEY, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [KEY_VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(token: string, aad: string): string {
    const [ver, iv, tag, ct] = token.split('.');
    if (ver !== KEY_VERSION || !iv || !tag || !ct) throw new Error('Unsupported ciphertext');
    const d = createDecipheriv('aes-256-gcm', DATA_KEY, Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  }

  encryptNumber(n: number | null | undefined, aad: string): string | null {
    return n == null ? null : this.encrypt(String(n), aad);
  }

  decryptNumber(token: string | null | undefined, aad: string): number | null {
    return token ? Number(this.decrypt(token, aad)) : null;
  }

  /** Keyed hash for duplicate detection without decrypting (mobile numbers, audit chain). */
  hmac(value: string, purpose = 'generic'): string {
    return createHmac('sha256', HMAC_KEY).update(`${purpose}:${value}`).digest('hex');
  }

  sha256(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
  }

  token(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  /** Short numeric code, uniform over the range (no modulo bias). */
  numericCode(digits = 6): string {
    const max = 10 ** digits;
    const limit = Math.floor(0x100000000 / max) * max;
    for (;;) {
      const n = randomBytes(4).readUInt32BE(0);
      if (n < limit) return String(n % max).padStart(digits, '0');
    }
  }

  safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }

  // ---- passwords: Argon2id (OWASP minimum profile: 19 MiB, t=2, p=1) ----
  hashPassword(password: string): Promise<string> {
    return argonHash(password, { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  }

  private dummyHash?: Promise<string>;

  /** Burn the same CPU as a real verification when a login names an unknown user (no user-enumeration timing signal). */
  async dummyVerify(password: string): Promise<false> {
    this.dummyHash ??= this.hashPassword('not-a-real-password');
    await this.verifyPassword(await this.dummyHash, password);
    return false;
  }

  async verifyPassword(hash: string | null | undefined, password: string): Promise<boolean> {
    if (!hash) return false;
    try {
      return await argonVerify(hash, password);
    } catch {
      return false;
    }
  }
}

