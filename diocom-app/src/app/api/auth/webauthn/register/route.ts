import { NextResponse } from 'next/server';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../[...nextauth]/route';
import db from '@/db';

const rpName = 'Datran Secure Transfer';
const rpID = 'localhost'; // Should match domain in prod
const origin = `http://${rpID}:3000`; // Should match origin in prod

export async function GET(request: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const userRes = await db.query('SELECT * FROM users WHERE email = $1', [session.user.email]);
    const user = userRes.rows[0];
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    // Ensure user.id exists for webauthn (might need generating if legacy)
    const userId = user.id; 

    // Get existing credentials to prevent re-registering
    const userCredentialsRes = await db.query('SELECT id FROM webauthn_credentials WHERE user_id = $1', [userId]);
    const userCredentials = userCredentialsRes.rows;

    const options = await generateRegistrationOptions({
        rpName,
        rpID,
        userID: new Uint8Array(Buffer.from(userId)),
        userName: user.email,
        timeout: 60000,
        attestationType: 'none',
        excludeCredentials: userCredentials.map(cred => ({
            id: cred.id, // v10 uses base64url strings directly usually, or Uint8Array
            transports: [],
        })),
        authenticatorSelection: {
            residentKey: 'required',
            userVerification: 'preferred',
        },
    });

    // Save challenge
    await db.query('UPDATE users SET current_challenge = $1 WHERE id = $2', [options.challenge, userId]);

    return NextResponse.json(options);
}

export async function POST(request: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const userRes = await db.query('SELECT * FROM users WHERE email = $1', [session.user.email]);
    const user = userRes.rows[0];
    
    if (!user || !user.current_challenge) return NextResponse.json({ error: 'Challenge expired' }, { status: 400 });

    try {
        const verification = await verifyRegistrationResponse({
            response: body,
            expectedChallenge: user.current_challenge,
            expectedOrigin: origin,
            expectedRPID: rpID,
        });

        if (verification.verified && verification.registrationInfo) {
            const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
            const { id: credentialID, publicKey: credentialPublicKey, counter } = credential;
            
            // Convert buffers for sqlite BLOB (now bytea)
            const credentialIDBase64url = Buffer.from(credentialID).toString('base64url');

            await db.query(`
                INSERT INTO webauthn_credentials (id, user_id, public_key, counter, device_type, backed_up, transports)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [
                credentialIDBase64url,
                user.id,
                Buffer.from(credentialPublicKey),
                counter,
                credentialDeviceType,
                credentialBackedUp, // Postgres boolean handles this
                JSON.stringify(body.response.transports || [])
            ]);

            // Clear challenge
            await db.query('UPDATE users SET current_challenge = NULL WHERE id = ?', [user.id]);

            return NextResponse.json({ verified: true });
        }
        return NextResponse.json({ verified: false }, { status: 400 });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 400 });
    }
}
