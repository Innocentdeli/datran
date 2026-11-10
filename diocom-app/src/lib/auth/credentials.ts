import { randomUUID } from 'crypto';
import db from '@/db';
import { AuditLogger } from '@/lib/AuditLogger';
import { hashPassword, verifyPassword, needsRehash } from '@/lib/security';
import { consumeRateLimit } from '@/lib/rateLimit';
import { consumePasskeyLoginToken } from '@/app/api/auth/webauthn/_shared';
import { getLogger } from '@/lib/observability';

/**
 * Credentials / passkey / sign-up checks shared by the NextAuth credentials provider (web cookie sessions) and the
 * mobile token endpoint (POST /api/mobile/token): same rate limits, same timing equalisation, same rehash.
 */

export const SIGNIN_LIMIT = { maxRequests: 10, windowMs: 5 * 60 * 1000 };
export const SIGNUP_LIMIT = { maxRequests: 5, windowMs: 60 * 60 * 1000 };
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
export const MIN_PASSWORD_LENGTH = 8;

/** Thrown for refused logins; `rateLimited` distinguishes 429 from 401 for API callers. */
export class CredentialsError extends Error {
    constructor(message: string, readonly rateLimited = false) {
        super(message);
        this.name = 'CredentialsError';
    }
}

const TOO_MANY = 'Too many attempts. Please try again later.';

// Pre-computed hash used to equalise timing when the user does not exist
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash() {
    if (!dummyHashPromise) dummyHashPromise = hashPassword(randomUUID());
    return dummyHashPromise;
}

export interface UserRow {
    id: string;
    name: string | null;
    email: string;
    password_hash: string | null;
    image: string | null;
    role: string;
    username?: string | null;
}

type NewUser = { email: string; name?: string | null; image?: string | null; username?: string | null };

// Minimal custom adapter for PostgreSQL
export const PostgresAdapter = {
    createUser: async <T extends NewUser>(user: T, provider = 'google', password?: string): Promise<T & { id: string; username: string }> => {
        const id = randomUUID();
        const now = Date.now();
        const passwordHash = password ? await hashPassword(password) : null;
        const cleanUsername = user.username
            ? user.username.replace(/^@/, '').toLowerCase().trim()
            : user.email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) + '_' + Math.random().toString(36).slice(2, 6);

        await db.query(
            "INSERT INTO users (id, name, email, password_hash, image, provider, role, username, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            [id, user.name || cleanUsername, user.email, passwordHash, user.image || '', provider, 'user', cleanUsername, now]
        );
        return { ...user, id, username: cleanUsername };
    },
    getUserByEmail: async (email: string): Promise<UserRow | undefined> => {
        const res = await db.query("SELECT * FROM users WHERE email = $1", [email]);
        return res.rows[0] as UserRow | undefined;
    },
    getUserByUsername: async (username: string): Promise<UserRow | undefined> => {
        const clean = username.replace(/^@/, '').toLowerCase().trim();
        const res = await db.query("SELECT * FROM users WHERE LOWER(username) = $1", [clean]);
        return res.rows[0] as UserRow | undefined;
    },
    getUser: async (id: string): Promise<UserRow | undefined> => {
        const res = await db.query("SELECT * FROM users WHERE id = $1", [id]);
        return res.rows[0] as UserRow | undefined;
    },
};

export interface AuthorizedUser {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
    role: string;
    username?: string | null;
}

export type CredentialsInput = Partial<Record<'email' | 'password' | 'isSignUp' | 'passkeyToken' | 'username', string>> | undefined;

/**
 * Verifies an email+password (or sign-up, or a single-use passkey login token). Returns the user, null for a
 * malformed request, or throws CredentialsError (rateLimited=true for rate-limit refusals).
 * `allowSignUp=false` ignores isSignUp (the mobile endpoint never creates accounts).
 */
export async function authorizeCredentials(credentials: CredentialsInput, ip: string, opts: { allowSignUp?: boolean } = {}): Promise<AuthorizedUser | null> {
    if (!(await consumeRateLimit(`signin:ip:${ip}`, SIGNIN_LIMIT))) throw new CredentialsError(TOO_MANY, true);

    // Passkey login: only a server-issued, single-use token bound to a user is accepted
    if (credentials?.passkeyToken) {
        const userId = await consumePasskeyLoginToken(credentials.passkeyToken);
        if (!userId) throw new CredentialsError('Passkey session expired. Please try again.');
        const user = await PostgresAdapter.getUser(userId);
        if (!user) throw new CredentialsError('Passkey session expired. Please try again.');
        return { id: user.id, name: user.name, email: user.email, image: user.image, role: user.role, username: user.username };
    }

    const email = typeof credentials?.email === 'string' ? credentials.email.trim() : '';
    if (!email || !EMAIL_RE.test(email)) return null;
    if (!(await consumeRateLimit(`signin:email:${email.toLowerCase()}`, SIGNIN_LIMIT))) throw new CredentialsError(TOO_MANY, true);

    const user = await PostgresAdapter.getUserByEmail(email);

    if (opts.allowSignUp !== false && credentials?.isSignUp === 'true') {
        if (!(await consumeRateLimit(`signup:ip:${ip}`, SIGNUP_LIMIT))) throw new CredentialsError(TOO_MANY, true);
        if (!credentials.password || credentials.password.length < MIN_PASSWORD_LENGTH) {
            throw new CredentialsError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
        }
        if (user) throw new CredentialsError('User already exists');

        let customUsername: string | undefined = undefined;
        if (credentials.username && typeof credentials.username === 'string' && credentials.username.trim()) {
            const raw = credentials.username.replace(/^@/, '').toLowerCase().trim();
            if (!/^[a-z0-9_]{3,30}$/.test(raw)) {
                throw new CredentialsError('Username must be 3-30 letters, numbers, or underscores.');
            }
            const existing = await PostgresAdapter.getUserByUsername(raw);
            if (existing) {
                throw new CredentialsError(`Username @${raw} is already taken. Please choose another.`);
            }
            customUsername = raw;
        }

        const newUser = await PostgresAdapter.createUser({ email, username: customUsername }, 'credentials', credentials.password);

        AuditLogger.record({
            userId: newUser.id,
            action: 'USER_SIGNUP',
            resource: 'AUTH',
            details: `Created new account with email ${email} and username @${newUser.username}`
        });

        return { id: newUser.id, name: newUser.username || email.split('@')[0], email, image: null, role: 'user', username: newUser.username };
    }

    if (!credentials?.password || !user || !user.password_hash) {
        // Burn equivalent time so responses don't reveal whether the account exists
        await verifyPassword(credentials?.password || '', await getDummyHash());
        throw new CredentialsError('Invalid email or password');
    }

    const isValid = await verifyPassword(credentials.password, user.password_hash);
    if (!isValid) throw new CredentialsError('Invalid email or password');

    // Transparently upgrade legacy (1000-iteration PBKDF2) hashes
    if (needsRehash(user.password_hash)) {
        try {
            const upgraded = await hashPassword(credentials.password);
            await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [upgraded, user.id]);
        } catch (e) {
            getLogger().error({ err: e }, 'password rehash failed');
        }
    }

    return { id: user.id, name: user.name, email: user.email, image: user.image, role: user.role, username: user.username };
}
