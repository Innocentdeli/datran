import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import FacebookProvider from "next-auth/providers/facebook";
import CredentialsProvider from "next-auth/providers/credentials";
import { AuditLogger } from "@/lib/AuditLogger";
import { getAppSecret, getClientIp } from "@/lib/security";
import { authorizeCredentials, PostgresAdapter } from "@/lib/auth/credentials";
import { recordAuth, setRequestUser } from "@/lib/observability";

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

// NextAuth configuration. Lives outside app/api/auth/[...nextauth]/route.ts because route modules may only export
// HTTP handlers and route config. Credentials / passkey / sign-up checks: src/lib/auth/credentials.ts.

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
                // diocom_auth_attempts_total{method=password|passkey|signup, result}
                const method = credentials?.passkeyToken ? 'passkey' : credentials?.isSignUp === 'true' ? 'signup' : 'password';
                try {
                    const user = await authorizeCredentials(credentials, ipFromAuthorizeReq(req));
                    recordAuth(method, user ? 'success' : 'failure');
                    if (user) setRequestUser(user.id);
                    return user;
                } catch (e) {
                    recordAuth(method, e instanceof Error && e.message.startsWith('Too many attempts') ? 'rate_limited' : 'failure');
                    throw e;
                }
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
                recordAuth(provider === 'google' || provider === 'facebook' ? provider : 'oauth', 'success');
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
            // Every getServerSession() inside a withObservability() route binds userId to the request logger.
            setRequestUser(token.id);
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
