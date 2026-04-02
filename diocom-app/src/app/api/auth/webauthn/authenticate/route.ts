import { NextResponse } from 'next/server';
import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../[...nextauth]/route';
import db from '@/db';

const rpID = 'localhost'; // Match domain in production
const origin = `http://${rpID}:3000`; // Match origin in production

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email');

    if (!email) return NextResponse.json({ error: 'Email required' }, { status: 400 });

    const userRes = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = userRes.rows[0];
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    const userCredentialsRes = await db.query('SELECT id FROM webauthn_credentials WHERE user_id = $1', [user.id]);
    const userCredentials = userCredentialsRes.rows;

    if (userCredentials.length === 0) {
        return NextResponse.json({ error: 'No passkey registered for this user' }, { status: 404 });
    }

    const options = await generateAuthenticationOptions({
        rpID,
        allowCredentials: userCredentials.map(cred => ({
            id: cred.id,
            transports: [],
        })),
        userVerification: 'preferred',
    });

    await db.query('UPDATE users SET current_challenge = $1 WHERE id = $2', [options.challenge, user.id]);

    return NextResponse.json(options);
}

export async function POST(request: Request) {
    const body = await request.json();
    const { _email, ...authResponse } = body;

    const userRes = await db.query('SELECT * FROM users WHERE email = $1', [_email]);
    const user = userRes.rows[0];
    if (!user || !user.current_challenge) return NextResponse.json({ error: 'Invalid challenge state' }, { status: 400 });

    const credIdBase64url = typeof authResponse.id === 'string' ? authResponse.id : Buffer.from(authResponse.id).toString('base64url');
    // In theory, should search by credId directly, but mapping it to user for exact validation
    const credentialRes = await db.query('SELECT * FROM webauthn_credentials WHERE id = $1 AND user_id = $2', [credIdBase64url, user.id]);
    const credential = credentialRes.rows[0];

    if (!credential) return NextResponse.json({ error: 'Credential not recognized' }, { status: 401 });

    try {
        const verification = await verifyAuthenticationResponse({
            response: authResponse,
            expectedChallenge: user.current_challenge,
            expectedOrigin: origin,
            expectedRPID: rpID,
            credential: {
                id: credential.id,
                publicKey: new Uint8Array(credential.public_key), // Postgres BYTEA returns Buffer
                counter: credential.counter,
                transports: typeof credential.transports === 'string' ? JSON.parse(credential.transports) : (credential.transports || [])
            }
        });

        if (verification.verified) {
            await db.query('UPDATE webauthn_credentials SET counter = $1 WHERE id = $2', [verification.authenticationInfo.newCounter, credential.id]);
            await db.query('UPDATE users SET current_challenge = NULL WHERE id = $1', [user.id]);
            
            return NextResponse.json({ verified: true, userId: user.id });
        }
        return NextResponse.json({ verified: false }, { status: 400 });

    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 400 });
    }
}
