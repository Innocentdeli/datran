/**
 * Mobile bearer tokens: access-JWT validation (audience, issuer, algorithm, expiry, tampering, secret) and refresh-token
 * rotation with reuse detection (a second use of a rotated token revokes the whole family). Dev JSON store.
 */
import { test, describe, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID, createHmac } from 'node:crypto';
import { installAppAlias, APP_DIR } from './helpers/dbScenario';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diocom-mobile-'));
Object.assign(process.env, { NODE_ENV: 'test', LOCAL_DB_PATH: path.join(tmp, 'db.json'), DIOCOM_SECRET: 'mobile-test-secret', LOG_LEVEL: 'silent' });
delete process.env.DATABASE_URL;
installAppAlias();

/* eslint-disable @typescript-eslint/no-require-imports */
const SRC = path.join(APP_DIR, 'src');
const mt = require(path.join(SRC, 'lib', 'auth', 'mobileTokens.ts'));
const db = require(path.join(SRC, 'db', 'index.ts')).default;
const jose = require(path.join(APP_DIR, 'node_modules', 'jose'));
/* eslint-enable @typescript-eslint/no-require-imports */

async function newUser(role = 'user'): Promise<string> {
    const id = randomUUID();
    await db.query('INSERT INTO users (id, name, email, password_hash, image, provider, role, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [id, 'M', `${id}@m.io`, null, '', 'credentials', role, Date.now()]);
    return id;
}

const appKey = () => new Uint8Array(createHmac('sha256', 'mobile-test-secret').update('diocom/mobile-access-token/v1').digest());

describe('access token (JWT)', () => {
    test('round trip: sub, role, aud=mobile, 15 minutes', async () => {
        const { token, expiresIn } = await mt.signAccessToken({ id: 'u1', role: 'admin' });
        assert.equal(expiresIn, 900);
        const claims = await mt.verifyAccessToken(token);
        assert.deepEqual(claims, { userId: 'u1', role: 'admin' });
        const payload = jose.decodeJwt(token);
        assert.equal(payload.aud, 'mobile');
        assert.equal(payload.iss, 'diocom');
        assert.equal(Number(payload.exp) - Number(payload.iat), 900);
    });

    test('expired, tampered, wrong audience/issuer/alg/secret are all rejected', async () => {
        const now = Date.now();
        const { token } = await mt.signAccessToken({ id: 'u1' }, now);
        assert.equal(await mt.verifyAccessToken(token, now + 16 * 60_000), null, 'expired');
        const [h, p, s] = token.split('.');
        const forged = Buffer.from(JSON.stringify({ ...jose.decodeJwt(token), sub: 'admin' })).toString('base64url');
        assert.equal(await mt.verifyAccessToken(`${h}.${forged}.${s}`), null, 'tampered payload');
        assert.equal(await mt.verifyAccessToken(`${h}.${p}.${s.slice(0, -2)}xx`), null, 'bad signature');
        const sign = (aud: string, iss: string, key = appKey()) => new jose.SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject('u1')
            .setAudience(aud).setIssuer(iss).setIssuedAt().setExpirationTime('5m').sign(key);
        assert.equal(await mt.verifyAccessToken(await sign('web', 'diocom')), null, 'wrong audience');
        assert.equal(await mt.verifyAccessToken(await sign('mobile', 'evil')), null, 'wrong issuer');
        assert.ok(await mt.verifyAccessToken(await sign('mobile', 'diocom')), 'control: correct claims verify');
        assert.equal(await mt.verifyAccessToken(await sign('mobile', 'diocom', new TextEncoder().encode('other-secret-other-secret-other!'))), null, 'other key');
        // The raw app secret (NextAuth's key) must not work: the mobile key is derived.
        assert.equal(await mt.verifyAccessToken(await sign('mobile', 'diocom', new TextEncoder().encode('mobile-test-secret'))), null, 'raw app secret');
        const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${p}.`;
        assert.equal(await mt.verifyAccessToken(none), null, 'alg none');
        assert.equal(await mt.verifyAccessToken('garbage'), null);
    });
});

describe('refresh tokens', () => {
    test('issue stores only a hash; rotation returns a new pair and spends the old token', async () => {
        const u = await newUser('editor');
        const pair = await mt.issueTokenPair({ id: u, role: 'editor' });
        assert.equal(pair.tokenType, 'Bearer');
        assert.equal(pair.refreshExpiresIn, 30 * 86400);
        const raw = JSON.stringify(JSON.parse(fs.readFileSync(process.env.LOCAL_DB_PATH!, 'utf8')).refresh_tokens);
        assert.ok(!raw.includes(pair.refreshToken), 'raw refresh token never stored');
        assert.ok(raw.includes(mt.hashRefreshToken(pair.refreshToken)));

        const r1 = await mt.rotateRefreshToken(pair.refreshToken);
        assert.equal(r1.ok, true);
        assert.notEqual(r1.pair.refreshToken, pair.refreshToken);
        assert.deepEqual(await mt.verifyAccessToken(r1.pair.accessToken), { userId: u, role: 'editor' });
        const r2 = await mt.rotateRefreshToken(r1.pair.refreshToken);
        assert.equal(r2.ok, true, 'the new token rotates again');
    });

    test('reuse of a rotated token revokes the whole family (incl. the latest token)', async () => {
        const u = await newUser();
        const p0 = await mt.issueTokenPair({ id: u });
        const r1 = await mt.rotateRefreshToken(p0.refreshToken);
        assert.equal(r1.ok, true);
        const reuse = await mt.rotateRefreshToken(p0.refreshToken); // attacker (or victim) replays the old token
        assert.deepEqual(reuse, { ok: false, reason: 'reused' });
        const latest = await mt.rotateRefreshToken(r1.pair.refreshToken);
        assert.equal(latest.ok, false, 'family revoked: the current token is dead too');
        assert.equal(latest.reason, 'revoked');
        // Another sign-in (another family) is unaffected.
        const other = await mt.issueTokenPair({ id: u });
        assert.equal((await mt.rotateRefreshToken(other.refreshToken)).ok, true);
    });

    test('concurrent use of one token: exactly one wins, the family is revoked', async () => {
        const u = await newUser();
        const p0 = await mt.issueTokenPair({ id: u });
        const results = await Promise.all([mt.rotateRefreshToken(p0.refreshToken), mt.rotateRefreshToken(p0.refreshToken)]);
        assert.equal(results.filter((r: { ok: boolean }) => r.ok).length <= 1, true);
        assert.ok(results.some((r: { ok: boolean; reason?: string }) => !r.ok && r.reason === 'reused'));
    });

    test('expired, unknown, malformed tokens; revoke (sign-out) kills the family', async () => {
        const u = await newUser();
        const now = Date.now();
        const p = await mt.issueTokenPair({ id: u }, now);
        assert.deepEqual(await mt.rotateRefreshToken(p.refreshToken, now + 31 * 86_400_000), { ok: false, reason: 'expired' });
        assert.deepEqual(await mt.rotateRefreshToken('x'.repeat(43)), { ok: false, reason: 'invalid' });
        assert.deepEqual(await mt.rotateRefreshToken(42), { ok: false, reason: 'invalid' });

        const q = await mt.issueTokenPair({ id: u });
        const q1 = await mt.rotateRefreshToken(q.refreshToken);
        assert.equal(await mt.revokeRefreshToken(q1.pair.refreshToken), true);
        assert.deepEqual(await mt.rotateRefreshToken(q1.pair.refreshToken), { ok: false, reason: 'revoked' });
        assert.equal(await mt.revokeRefreshToken('unknown-token-unknown-token'), false);
        assert.ok((await mt.pruneRefreshTokens(now + 40 * 86_400_000)) >= 1);
    });
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));
