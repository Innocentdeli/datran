import db from '@/db';
import { randomBytes, createHash, randomUUID } from 'crypto';

export interface ApiKeyRecord {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  last_used_at: number | null;
  expires_at: number | null;
  created_at: number;
}

export const ApiKeyService = {
  /** Create a new API key with prefix `dtr_live_` */
  async createApiKey(userId: string, name: string): Promise<{
    id: string;
    apiKey: string;
    name: string;
    keyPrefix: string;
    createdAt: number;
  }> {
    const cleanName = name.trim();
    if (!cleanName) throw new Error('Key name is required');

    const randomPart = randomBytes(24).toString('hex');
    const apiKey = `dtr_live_${randomPart}`;
    const keyHash = createHash('sha256').update(apiKey).digest('hex');
    const keyPrefix = `${apiKey.slice(0, 14)}...`;
    const id = randomUUID();
    const now = Date.now();

    await db.query(`
      INSERT INTO api_keys (
        id, user_id, name, key_hash, key_prefix, last_used_at, expires_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      id,
      userId,
      cleanName,
      keyHash,
      keyPrefix,
      null,
      null,
      now,
    ]);

    return {
      id,
      apiKey,
      name: cleanName,
      keyPrefix,
      createdAt: now,
    };
  },

  /** List all API keys for an authenticated user */
  async listApiKeys(userId: string): Promise<ApiKeyRecord[]> {
    const res = await db.query('SELECT * FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    return res.rows.map((r) => ({
      id: r.id as string,
      user_id: r.user_id as string,
      name: r.name as string,
      key_prefix: r.key_prefix as string,
      last_used_at: r.last_used_at ? Number(r.last_used_at) : null,
      expires_at: r.expires_at ? Number(r.expires_at) : null,
      created_at: Number(r.created_at),
    }));
  },

  /** Delete or revoke an API key */
  async deleteApiKey(userId: string, keyId: string): Promise<boolean> {
    await db.query('DELETE FROM api_keys WHERE id = $1 AND user_id = $2', [keyId, userId]);
    return true;
  },

  /** Authenticate a bearer token from request headers */
  async authenticateToken(token: string): Promise<{ id: string; email: string; name: string } | null> {
    if (!token || !token.startsWith('dtr_live_')) return null;

    const hash = createHash('sha256').update(token.trim()).digest('hex');
    const res = await db.query('SELECT * FROM api_keys WHERE key_hash = $1', [hash]);
    const keyRecord = res.rows[0];
    if (!keyRecord) return null;

    // Check expiry if set
    if (keyRecord.expires_at && Date.now() > Number(keyRecord.expires_at)) {
      return null;
    }

    // Touch last_used_at
    const now = Date.now();
    await db.query('UPDATE api_keys SET last_used_at = $1 WHERE id = $2', [now, keyRecord.id]);

    // Fetch user
    const userRes = await db.query('SELECT * FROM users WHERE id = $1', [keyRecord.user_id]);
    const user = userRes.rows[0];
    if (!user || user.is_banned) return null;

    return {
      id: user.id as string,
      email: (user.email as string) || '',
      name: (user.name as string) || 'API User',
    };
  },
};
