import { NextResponse } from 'next/server';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../[...nextauth]/route';
import db from '@/db';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getWebAuthnConfig, storeChallenge, takeChallenge } from '../_shared';

const LIMIT = { maxRequests: 10, windowMs: 60_000 };

// Registration requires an authenticated session: passkeys can only be attached
// to the account of the currently signed-in user.
async function getSessionUser() {
    const session = await getServerSession(authOptions);
    const sessionUser = session?.user as { id?: string; email?: string | null } | undefined;
    if (!sessionUser?.id) return null;
    const userRes = await db.query('SELECT * FROM users WHERE id = $1', [sessionUser.id]);
    return userRes.rows[0] || null;
}

export async function GET(request: Request) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        const limited = await enforceRateLimit(request, 'webauthn-reg-options', LIMIT, user.id);
        if (limited) return limited;

        const { rpID, rpName } = getWebAuthnConfig();
        const credsRes = await db.query('SELECT id FROM webauthn_credentials WHERE user_id = $1', [user.id]);

        const options = await generateRegistrationOptions({
            rpName,
            rpID,
            userID: new Uint8Array(Buffer.from(String(user.id))),
            userName: user.email,
            timeout: 60000,
            attestationType: 'none',
            excludeCredentials: credsRes.rows.map((cred: { id: string }) => ({ id: cred.id, transports: [] })),
            authenticatorSelection: {
                residentKey: 'required',
                userVerification: 'preferred',
            },
        });

        await storeChallenge('reg', user.id, options.challenge);
        return NextResponse.json(options);
    } catch (e) {
        console.error('[webauthn/register GET]', e);
        return NextResponse.json({ error: 'Could not start passkey registration' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        const limited = await enforceRateLimit(request, 'webauthn-reg-verify', LIMIT, user.id);
        if (limited) return limited;

        const body = await request.json();
        // Single-use challenge, atomically consumed (GETDEL)
        const expectedChallenge = await takeChallenge('reg', user.id);
        if (!expectedChallenge) return NextResponse.json({ error: 'Challenge expired' }, { status: 400 });

        const { rpID, origin } = getWebAuthnConfig();
        const verification = await verifyRegistrationResponse({
            response: body,
            expectedChallenge,
            expectedOrigin: origin,
            expectedRPID: rpID,
        });

        if (verification.verified && verification.registrationInfo) {
            const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
            const { id: credentialID, publicKey: credentialPublicKey, counter } = credential;

            // In @simplewebauthn/server v13, credential.id is already a base64url string
            const transports = Array.isArray(body?.response?.transports) ? body.response.transports : [];

            await db.query(`
                INSERT INTO webauthn_credentials (id, user_id, public_key, counter, device_type, backed_up, transports)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [
                credentialID,
                user.id,
                Buffer.from(credentialPublicKey),
                counter,
                credentialDeviceType,
                credentialBackedUp,
                JSON.stringify(transports),
            ]);

            return NextResponse.json({ verified: true });
        }
        return NextResponse.json({ verified: false }, { status: 400 });
    } catch (e) {
        console.error('[webauthn/register POST]', e);
        return NextResponse.json({ error: 'Passkey registration failed' }, { status: 400 });
    }
}
