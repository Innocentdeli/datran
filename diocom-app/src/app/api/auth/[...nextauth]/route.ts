import NextAuth from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import FacebookProvider from "next-auth/providers/facebook";
import CredentialsProvider from "next-auth/providers/credentials";
import db from "@/db"; // Your SQLite connection
import { randomUUID, pbkdf2Sync, randomBytes } from "crypto";
import { AuditLogger } from "@/lib/AuditLogger";

// Helper for password hashing
function hashPassword(password: string) {
    const salt = randomBytes(16).toString('hex');
    const hash = pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password: string, storedHash: string) {
    const [salt, hash] = storedHash.split(':');
    const verifyHash = pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return hash === verifyHash;
}

// Minimal custom adapter for PostgreSQL
const PostgresAdapter = {
    createUser: async (user: any, provider = 'google', password?: string) => {
        const id = randomUUID();
        const now = Date.now();
        const passwordHash = password ? hashPassword(password) : null;

        await db.query(
            "INSERT INTO users (id, name, email, password_hash, image, provider, role, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            [id, user.name || user.email.split('@')[0], user.email, passwordHash, user.image || '', provider, 'user', now]
        );
        return { ...user, id };
    },
    getUserByEmail: async (email: string) => {
        const res = await db.query("SELECT * FROM users WHERE email = $1", [email]);
        return res.rows[0];
    },
    getUser: async (id: string) => {
        const res = await db.query("SELECT * FROM users WHERE id = $1", [id]);
        return res.rows[0];
    },
};

export const authOptions = {
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
                passkeyVerified: { label: "Passkey", type: "text" } // Hidden flag for WebAuthn
            },
            async authorize(credentials) {
                if (!credentials?.email) return null;

                // Handle Guest Demo
                if (credentials.email === "guest@diocom.io" && credentials.password === "demo") {
                    return {
                        id: "guest-1",
                        name: "Guest User",
                        email: "guest@diocom.io",
                        role: "guest",
                        image: "https://github.com/shadcn.png"
                    };
                }

                const user: any = await PostgresAdapter.getUserByEmail(credentials.email);

                if (credentials.isSignUp === 'true') {
                    if (user) throw new Error('User already exists');
                    const newUser = await PostgresAdapter.createUser({ email: credentials.email }, 'credentials', credentials.password);
                    
                    AuditLogger.record({
                        userId: newUser.id,
                        action: 'USER_SIGNUP',
                        resource: 'AUTH',
                        details: `Created new account with email ${credentials.email}`
                    });

                    return newUser;
                }

                if (!user) throw new Error('Invalid user');

                // Passkey Bypass (Cryptographically verified in /api/auth/webauthn/authenticate)
                if (credentials.passkeyVerified === 'true') {
                    return {
                        id: user.id,
                        name: user.name,
                        email: user.email,
                        image: user.image,
                        role: user.role
                    };
                }

                if (!credentials.password || !user.password_hash) {
                    throw new Error('Invalid email or password');
                }

                const isValid = verifyPassword(credentials.password, user.password_hash);
                if (!isValid) throw new Error('Invalid email or password');

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
        strategy: 'jwt' as const,
    },
    callbacks: {
        async signIn({ user, account }: any) {
            if (!user.email) return false;

            // For social providers, auto-link or create
            if (account?.provider !== 'credentials') {
                const existingUser = await PostgresAdapter.getUserByEmail(user.email);
                if (!existingUser) {
                    const newUser: any = await PostgresAdapter.createUser(user, account?.provider);
                    AuditLogger.record({
                        userId: newUser.id,
                        action: 'USER_SIGNUP',
                        resource: 'AUTH_SOCIAL',
                        details: `Created new account via ${account?.provider} (${user.email})`
                    });
                } else {
                    AuditLogger.record({
                        userId: (existingUser as any).id,
                        action: 'USER_SIGNIN',
                        resource: `AUTH_${account?.provider.toUpperCase()}`,
                        details: `User signed in via ${account?.provider}`
                    });
                }
            } else {
                // For credentials provider, authorize already handled signup log,
                // but we record the signin here for consistency if it's not a signup.
                const existingUser: any = await PostgresAdapter.getUserByEmail(user.email);
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
        async jwt({ token, user }: any) {
            if (user) {
                token.id = user.id;
                token.role = (user as any).role || 'user';
            }
            return token;
        },
        async session({ session, token }: any) {
            if (session.user) {
                (session.user as any).id = token.id;
                (session.user as any).role = token.role;
            }
            return session;
        }
    },
    pages: {
        signIn: '/auth/signin',
    },
    secret: process.env.NEXTAUTH_SECRET || 'secret',
};

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
