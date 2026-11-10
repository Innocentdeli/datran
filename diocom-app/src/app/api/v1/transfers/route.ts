import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { requireRequestUser, isRequestUser } from '@/lib/auth/requestUser';
import { FileRepository, toPublicFile } from '@/db/files';
import { localPathForKey, getStorageRoot } from '@/lib/storage';
import { sanitizeFilename } from '@/lib/validation';
import { hashPassword } from '@/lib/security';
import { resolveOrigin } from '@/config';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await requireRequestUser(req);
  if (!isRequestUser(user)) return user;

  try {
    const files = await FileRepository.findByUserId(user.id);
    return NextResponse.json({
      success: true,
      transfers: files.map(toPublicFile),
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error)?.message || 'Failed to list transfers' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const user = await requireRequestUser(req);
  if (!isRequestUser(user)) return user;

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;

    if (!file || typeof file === 'string' || !file.name) {
      return NextResponse.json(
        { error: 'A valid file must be provided in the "file" field.' },
        { status: 400 }
      );
    }

    const expiryHours = Number(formData.get('expiry_hours') || 24);
    const password = (formData.get('password') as string)?.trim() || null;
    const expiresAt = expiryHours > 0 ? Date.now() + expiryHours * 3600 * 1000 : null;

    const passwordHash = password ? await hashPassword(password) : null;
    const shareId = randomUUID().replace(/-/g, '').slice(0, 16);

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Ensure storage root directory exists
    const rootDir = getStorageRoot();
    if (!fs.existsSync(rootDir)) {
      fs.mkdirSync(rootDir, { recursive: true });
    }

    const storagePath = localPathForKey(shareId);
    await fs.promises.writeFile(storagePath, buffer);

    const createdRecord = await FileRepository.create({
      user_id: user.id,
      share_id: shareId,
      original_name: file.name,
      sanitized_name: sanitizeFilename(file.name),
      storage_path: storagePath,
      thumbnail_path: null,
      password_hash: passwordHash,
      file_size: buffer.length,
      mime_type: file.type || 'application/octet-stream',
      expires_at: expiresAt,
      compression_ratio: '1.0x',
      compression_speed: '0ms',
      tags: null,
      summary: null,
      is_external: 0,
      is_encrypted: 0,
      encryption_iv: null,
      similarity_token: null,
    });

    const origin = resolveOrigin(req);
    const publicUrl = `${origin}/v1/${shareId}`;

    return NextResponse.json({
      success: true,
      transfer: {
        id: createdRecord.id,
        shareId,
        url: publicUrl,
        fileName: file.name,
        fileSize: buffer.length,
        mimeType: file.type || 'application/octet-stream',
        hasPassword: !!passwordHash,
        expiresAt,
        createdAt: createdRecord.created_at,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error)?.message || 'Failed to process transfer upload' },
      { status: 500 }
    );
  }
}
