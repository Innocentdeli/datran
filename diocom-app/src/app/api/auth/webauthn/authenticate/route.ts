import { NextResponse } from 'next/server';
import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import db from '@/db';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getWebAuthnConfig, storeChallenge, takeChallenge, issuePasskeyLoginToken } from '../_shared';
import { withObservability, getLogger, recordAuth } from '@/lib/observability';

const LIMIT = { maxRequests: 10, windowMs: 60_000 };
const GENERIC_UNAVAILABLE = 'Passkey sign-in is not available for this account';

function normEmail(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const e = v.trim().toLowerCase();
    return e && e.length <= 320 ? e : null;
}

async function handleGET(request: Request) {
    const { searchParams } = new URL(request.url);
    const email = normEmail(searchParams.get('email'));
    if (!email) return NextResponse.json({ error: 'Email required' }, { status: 400 });

    const limited = await enforceRateLimit(request, 'webauthn-auth-options', LIMIT, email);
    if (limited) return limited;

    try {
        const { rpID } = getWebAuthnConfig();
        const userRes = await db.query('SELECT * FROM users WHERE LOWER(email) = $1', [email]);
        const user = userRes.rows[0];
        if (!user) return NextResponse.json({ error: GENERIC_UNAVAILABLE }, { status: 400 });

        const credsRes = await db.query('SELECT id, transports FROM webauthn_credentials WHERE user_id = $1', [user.id]);
        const userCredentials = credsRes.rows;
        if (userCredentials.length === 0) {
            return NextResponse.json({ error: GENERIC_UNAVAILABLE }, { status: 400 });
        }

        const options = await generateAuthenticationOptions({
            rpID,
            allowCredentials: userCredentials.map((cred: { id: string }) => ({ id: cred.id, transports: [] })),
            userVerification: 'preferred',
        });

        await storeChallenge('auth', user.id, options.challenge);
        return NextResponse.json(options);
    } catch (e) {
        getLogger().error({ err: e }, 'webauthn/authenticate GET');
        return NextResponse.json({ error: 'Could not start passkey authentication' }, { status: 500 });
    }
}

async function handlePOST(request: Request) {
    let body: Record<string, unknown>;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    const { _email, ...authResponse } = body;
    const email = normEmail(_email);
    if (!email) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

    const limited = await enforceRateLimit(request, 'webauthn-auth-verify', LIMIT, email);
    if (limited) return limited;

    try {
        const { rpID, origin } = getWebAuthnConfig();
        const userRes = await db.query('SELECT * FROM users WHERE LOWER(email) = $1', [email]);
        const user = userRes.rows[0];
        // Challenge is single-use: atomically consumed (GETDEL) before verifying, so it can never be replayed
        const expectedChallenge = user ? await takeChallenge('auth', user.id) : null;
        if (!user || !expectedChallenge) {
            return NextResponse.json({ error: 'Invalid or expired challenge' }, { status: 400 });
        }

        const rawId = (authResponse as { id?: unknown }).id;
        if (typeof rawId !== 'string') return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

        const credentialRes = await db.query(
            'SELECT * FROM webauthn_credentials WHERE id = $1 AND user_id = $2',
            [rawId, user.id]
        );
        const credential = credentialRes.rows[0];
        if (!credential) recordAuth('webauthn', 'failure');
        if (!credential) return NextResponse.json({ error: 'Passkey authentication failed' }, { status: 401 });

        const verification = await verifyAuthenticationResponse({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            response: authResponse as any,
            expectedChallenge,
            expectedOrigin: origin,
            expectedRPID: rpID,
            requireUserVerification: false,
            credential: {
                id: credential.id,
                publicKey: new Uint8Array(credential.public_key),
                counter: Number(credential.counter) || 0,
                transports: typeof credential.transports === 'string'
                    ? JSON.parse(credential.transports)
                    : (credential.transports || []),
            },
        });

        if (!verification.verified) {
            recordAuth('webauthn', 'failure');
            return NextResponse.json({ error: 'Passkey authentication failed' }, { status: 401 });
        }

        // Counter regression is rejected by verifyAuthenticationResponse; persist new counter
        await db.query('UPDATE webauthn_credentials SET counter = $1 WHERE id = $2', [
            verification.authenticationInfo.newCounter,
            credential.id,
        ]);

        const loginToken = await issuePasskeyLoginToken(user.id);
        recordAuth('webauthn', 'success');
        return NextResponse.json({ verified: true, loginToken });
    } catch (e) {
        recordAuth('webauthn', 'error');
        getLogger().error({ err: e }, 'webauthn/authenticate POST');
        return NextResponse.json({ error: 'Passkey authentication failed' }, { status: 400 });
    }
}

export const GET = withObservability(handleGET, '/api/auth/webauthn/authenticate');
export const POST = withObservability(handlePOST, '/api/auth/webauthn/authenticate');
