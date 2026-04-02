import { NextResponse } from 'next/server';
import { FileRepository } from '@/db/files';
import { scryptSync } from 'crypto';
import { cookies } from 'next/headers';

export async function POST(request: Request) {
    try {
        const { shareId, password } = await request.json();

        if (!shareId || !password) {
            return new NextResponse('Missing credentials', { status: 400 });
        }

        const fileRecord = await FileRepository.findByShareId(shareId);

        if (!fileRecord || !fileRecord.password_hash) {
            return new NextResponse('File not found or not protected', { status: 404 });
        }

        // Verify Hash
        // Stored format: "salt:hash"
        const [salt, storedHash] = fileRecord.password_hash.split(':');
        const inputHash = scryptSync(password, salt, 64).toString('hex');

        if (inputHash !== storedHash) {
            return new NextResponse('Invalid password', { status: 401 });
        }

        // Set Cookie
        // We set a cookie specific to this shareId
        const cookieStore = await cookies();

        // Expiry: 24 hours
        cookieStore.set(`diocom_access_${shareId}`, '1', {
            secure: process.env.NODE_ENV === 'production',
            httpOnly: true,
            maxAge: 60 * 60 * 24
        });

        return NextResponse.json({ success: true });

    } catch (e) {
        console.error('[AUTH] Unlock error:', e);
        return new NextResponse('Internal Error', { status: 500 });
    }
}
