import * as crypto from 'crypto';

/**
 * FHELight (name kept for existing callers)
 *
 * HONEST DESCRIPTION: this is NOT homomorphic encryption and provides no confidentiality.
 * - encryptNumeric() returns `HMAC-SHA256(value):base64(value)` — the value is merely
 *   base64-encoded alongside an HMAC tag, so anyone can read it.
 * - homomorphicAdd() decodes both plaintexts, adds them and re-tags the sum.
 * - generateSimilarityToken() is a deterministic HMAC tag over the sorted tag list,
 *   which only supports exact-match comparison.
 */
export class FHELight {
    // Static HMAC key. Tags are deterministic and only used for exact-match comparisons.
    private static HMAC_KEY = 'datran_sovereign_fhe_prime_2026';

    /** Returns `hmacTag:base64(value)`. The value is NOT hidden. */
    public static encryptNumeric(value: number): string {
        const tag = crypto.createHmac('sha256', this.HMAC_KEY)
            .update(value.toString())
            .digest('hex');
        return `${tag}:${Buffer.from(value.toString()).toString('base64')}`;
    }

    /** Decodes both values, adds them in plaintext, and returns a newly tagged sum. */
    public static homomorphicAdd(cipherA: string, cipherB: string): string {
        const numA = this.decryptNumeric(cipherA);
        const numB = this.decryptNumeric(cipherB);
        return this.encryptNumeric(numA + numB);
    }

    /** Decodes the base64 value (no secret is required). */
    public static decryptNumeric(cipher: string): number {
        const [, val] = cipher.split(':');
        return parseInt(Buffer.from(val ?? '', 'base64').toString(), 10);
    }

    /** Deterministic HMAC-SHA256 tag over the sorted tag list (exact-match only). */
    public static generateSimilarityToken(tags: string[]): string {
        const normalized = [...tags].sort().join('|');
        return crypto.createHmac('sha256', this.HMAC_KEY)
            .update(normalized)
            .digest('hex');
    }

    /** Exact-match comparison of two HMAC tags (constant-time). */
    public static isSimilar(tokenA: string, tokenB: string): boolean {
        const a = Buffer.from(String(tokenA));
        const b = Buffer.from(String(tokenB));
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }
}
