import NextAuth, { type NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import FacebookProvider from "next-auth/providers/facebook";
import CredentialsProvider from "next-auth/providers/credentials";
import db from "@/db";
import { randomUUID } from "crypto";
import { AuditLogger } from "@/lib/AuditLogger";
import { getAppSecret, getClientIp, hashPassword, verifyPassword, needsRehash } from "@/lib/security";
import { consumeRateLimit } from "@/lib/rateLimit";
import { consumePasskeyLoginToken } from "../webauthn/_shared";

const SIGNIN_LIMIT = { maxRequests: 10, windowMs: 5 * 60 * 1000 };
const SIGNUP_LIMIT = { maxRequests: 5, windowMs: 60 * 60 * 1000 };
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const MIN_PASSWORD_LENGTH = 8;

// NextAuth passes a plain object for req.headers; adapt it for getClientIp
function ipFromAuthorizeReq(req: unknown): string {
    const raw = (req as { headers?: Record<string, string | string[] | undefined> } | undefined)?.headers || {};
    const headers = new Headers();
    for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v) && v.length) headers.set(k, v.join(','));
    }
    return getClientIp(new Request('http://localhost/', { headers }));
}

// Pre-computed hash used to equalise timing when the user does not exist
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash() {
    if (!dummyHashPromise) dummyHashPromise = hashPassword(randomUUID());
    return dummyHashPromise;
}

interface UserRow {
    id: string;
    name: string | null;
    email: string;
    password_hash: string | null;
    image: string | null;
    role: string;
}

type NewUser = { email: string; name?: string | null; image?: string | null };

// Minimal custom adapter for PostgreSQL
const PostgresAdapter = {
    createUser: async <T extends NewUser>(user: T, provider = 'google', password?: string): Promise<T & { id: string }> => {
        const id = randomUUID();
        const now = Date.now();
        const passwordHash = password ? await hashPassword(password) : null;

        await db.query(
            "INSERT INTO users (id, name, email, password_hash, image, provider, role, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            [id, user.name || user.email.split('@')[0], user.email, passwordHash, user.image || '', provider, 'user', now]
        );
        return { ...user, id };
    },
    getUserByEmail: async (email: string): Promise<UserRow | undefined> => {
        const res = await db.query<UserRow>("SELECT * FROM users WHERE email = $1", [email]);
        return res.rows[0];
    },
    getUser: async (id: string): Promise<UserRow | undefined> => {
        const res = await db.query<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
        return res.rows[0];
    },
};

export const authOptions: NextAuthOptions = {
    providers: [
        GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID || "",
            clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
        }),
        FacebookProvider({
            clientId: process.env.FACEBOOK_CLIENT_ID || "",
            clientSecret: process.env.FACEBOOK_CLIENT_SECRET || "",
        }),
        CredentialsProvider({
            name: "Credentials",
            credentials: {
                email: { label: "Email", type: "text" },
                password: { label: "Password", type: "password" },
                isSignUp: { label: "Sign Up", type: "text" }, // Hidden flag
                // Single-use token issued by /api/auth/webauthn/authenticate after a verified assertion
                passkeyToken: { label: "Passkey", type: "text" }
            },
            async authorize(credentials, req) {
                const ip = ipFromAuthorizeReq(req);
                if (!consumeRateLimit(`signin:ip:${ip}`, SIGNIN_LIMIT)) {
                    throw new Error('Too many attempts. Please try again later.');
                }

                // Passkey login: only a server-issued, single-use token bound to a user is accepted
                if (credentials?.passkeyToken) {
                    const userId = consumePasskeyLoginToken(credentials.passkeyToken);
                    if (!userId) throw new Error('Passkey session expired. Please try again.');
                    const user = await PostgresAdapter.getUser(userId);
                    if (!user) throw new Error('Passkey session expired. Please try again.');
                    return { id: user.id, name: user.name, email: user.email, image: user.image, role: user.role };
                }

                const email = typeof credentials?.email === 'string' ? credentials.email.trim() : '';
                if (!email || !EMAIL_RE.test(email)) return null;
                if (!consumeRateLimit(`signin:email:${email.toLowerCase()}`, SIGNIN_LIMIT)) {
                    throw new Error('Too many attempts. Please try again later.');
                }

                const user = await PostgresAdapter.getUserByEmail(email);

                if (credentials?.isSignUp === 'true') {
                    if (!consumeRateLimit(`signup:ip:${ip}`, SIGNUP_LIMIT)) {
                        throw new Error('Too many attempts. Please try again later.');
                    }
                    if (!credentials.password || credentials.password.length < MIN_PASSWORD_LENGTH) {
                        throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
                    }
                    if (user) throw new Error('User already exists');
                    const newUser = await PostgresAdapter.createUser({ email }, 'credentials', credentials.password);

                    AuditLogger.record({
                        userId: newUser.id,
                        action: 'USER_SIGNUP',
                        resource: 'AUTH',
                        details: `Created new account with email ${email}`
                    });

                    return { ...newUser, role: 'user' };
                }

                if (!credentials?.password || !user || !user.password_hash) {
                    // Burn equivalent time so responses don't reveal whether the account exists
                    await verifyPassword(credentials?.password || '', await getDummyHash());
                    throw new Error('Invalid email or password');
                }

                const isValid = await verifyPassword(credentials.password, user.password_hash);
                if (!isValid) throw new Error('Invalid email or password');

                // Transparently upgrade legacy (1000-iteration PBKDF2) hashes
                if (needsRehash(user.password_hash)) {
                    try {
                        const upgraded = await hashPassword(credentials.password);
                        await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [upgraded, user.id]);
                    } catch (e) {
                        console.error('[auth] Password rehash failed:', e);
                    }
                }

                return {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    image: user.image,
                    role: user.role
                };
            }
        })
    ],
    session: {
        strategy: 'jwt',
    },
    callbacks: {
        async signIn({ user, account }) {
            if (!user.email) return false;
            const provider = account?.provider ?? 'unknown';

            // For social providers, auto-link or create
            if (provider !== 'credentials') {
                const existingUser = await PostgresAdapter.getUserByEmail(user.email);
                if (!existingUser) {
                    const newUser = await PostgresAdapter.createUser({ email: user.email, name: user.name, image: user.image }, provider);
                    AuditLogger.record({
                        userId: newUser.id,
                        action: 'USER_SIGNUP',
                        resource: 'AUTH_SOCIAL',
                        details: `Created new account via ${provider} (${user.email})`
                    });
                } else {
                    AuditLogger.record({
                        userId: existingUser.id,
                        action: 'USER_SIGNIN',
                        resource: `AUTH_${provider.toUpperCase()}`,
                        details: `User signed in via ${provider}`
                    });
                }
            } else {
                // For credentials provider, authorize already handled signup log,
                // but we record the signin here for consistency if it's not a signup.
                const existingUser = await PostgresAdapter.getUserByEmail(user.email);
                if (existingUser) {
                    AuditLogger.record({
                        userId: existingUser.id,
                        action: 'USER_SIGNIN',
                        resource: 'AUTH_CREDENTIALS',
                        details: `User signed in via credentials`
                    });
                }
            }
            return true;
        },
        async jwt({ token, user }) {
            if (user) {
                token.id = user.id;
                token.role = user.role || 'user';
            }
            return token;
        },
        async session({ session, token }) {
            if (session.user) {
                session.user.id = token.id ?? '';
                session.user.role = token.role ?? 'user';
            }
            return session;
        }
    },
    pages: {
        signIn: '/auth/signin',
    },
    secret: getAppSecret(),
};

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
