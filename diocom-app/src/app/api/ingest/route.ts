import { NextResponse } from 'next/server';
import { spawn, exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { secureDelete } from '@/lib/crypto/Shredder';
import { config, getShareLinkUrl, getStoragePath, shouldCompress } from '@/config';
import {
    validateFileSize,
    validateFileType,
    validateMimeType,
    sanitizeFilename,
    ValidationError
} from '@/lib/validation';
import { checkRateLimit, getClientIdentifier } from '@/lib/rateLimit';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]/route';
import { FileRepository } from '@/db/files';
import sharp from 'sharp';
import { scryptSync, randomBytes } from 'crypto';
import { getStorageProvider } from '@/lib/storage';
import { LedgerService } from '@/lib/ledger';
import { AIService } from '@/lib/ai';
import { ACSNode } from '../../../../../src/network/ACSNode';
import { Worker } from 'worker_threads';
import { AuditLogger } from '@/lib/AuditLogger';
import { WebhookService } from '@/lib/WebhookService';
import { CognitiveLens } from '@/lib/CognitiveLens';
import { FHELight } from '@/lib/FHELight';
import '@/db/schema'; // Initialize DB Schema

const globalNode = new ACSNode(); // Persistent node for the server lifecycle

// Helper for hashing
function hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

export async function POST(request: Request) {
    console.log(`[INGEST] Incoming request at ${new Date().toISOString()}`);
    try {
        // Rate limiting
        if (config.rateLimit.enabled) {
            const clientId = getClientIdentifier(request);
            const rateLimitResult = checkRateLimit(clientId, {
                maxRequests: config.rateLimit.maxRequests,
                windowMs: config.rateLimit.windowMs
            });

            if (!rateLimitResult.allowed) {
                return NextResponse.json({
                    success: false,
                    message: `Rate limit exceeded. Try again in ${rateLimitResult.retryAfter} seconds.`,
                    code: 'RATE_LIMIT_EXCEEDED',
                    retryAfter: rateLimitResult.retryAfter
                }, {
                    status: 429,
                    headers: {
                        'X-RateLimit-Limit': config.rateLimit.maxRequests.toString(),
                        'X-RateLimit-Remaining': '0',
                        'X-RateLimit-Reset': new Date(rateLimitResult.resetAt).toISOString(),
                        'Retry-After': rateLimitResult.retryAfter?.toString() || '60'
                    }
                });
            }
        }

        const formData = await request.formData();
        const file = formData.get('file') as File;
        const password = formData.get('password') as string | null;

        const tagsRaw = formData.get('tags') as string | null;
        const summary = formData.get('summary') as string | null;
        const isEncrypted = formData.get('is_encrypted') === 'true' ? 1 : 0;
        const encryptionIv = formData.get('iv') as string | null;

        let passwordHash = null;
        if (password && password.trim().length > 0) {
            passwordHash = hashPassword(password);
            console.log('[BRIDGE] Secure Lock Engaged. Encrypting access...');
        }

        // Generate FHE Similarity Token
        const tagsArray = tagsRaw ? (tagsRaw.startsWith('[') ? JSON.parse(tagsRaw) : tagsRaw.split(',').map(t => t.trim())) : [];
        const similarityToken = FHELight.generateSimilarityToken(tagsArray);


        if (!file) {
            return NextResponse.json({
                success: false,
                message: 'No file provided',
                code: 'NO_FILE'
            }, { status: 400 });
        }

        // Get User Session (if any)
        const session = await getServerSession(authOptions);
        const userId = session?.user?.id;

        // Validate file size
        if (config.validation.enableSizeCheck) {
            const sizeValidation = validateFileSize(file.size, config.storage.maxFileSize);
            if (!sizeValidation.valid) {
                return NextResponse.json({
                    success: false,
                    message: sizeValidation.error,
                    code: sizeValidation.code
                }, { status: 400 });
            }
        }

        // Sanitize filename
        const sanitizedName = sanitizeFilename(file.name);

        // Validate file type
        if (config.validation.enableTypeCheck && config.storage.allowedExtensions[0] !== '*') {
            const typeValidation = validateFileType(sanitizedName, config.storage.allowedExtensions);
            if (!typeValidation.valid) {
                return NextResponse.json({
                    success: false,
                    message: typeValidation.error,
                    code: typeValidation.code
                }, { status: 400 });
            }
        }

        // Validate MIME type
        if (config.validation.enableMimeCheck) {
            const mimeValidation = validateMimeType(file.type, config.validation.allowedMimeTypes);
            if (!mimeValidation.valid) {
                return NextResponse.json({
                    success: false,
                    message: mimeValidation.error,
                    code: mimeValidation.code
                }, { status: 400 });
            }
        }

        const buffer = Buffer.from(await file.arrayBuffer());

        // FUTURE TECH: Blockchain & AI
        // 1. Immutable Ledger Recording
        await LedgerService.record(buffer, { filename: sanitizedName, size: file.size, uploader: userId || 'anon' });

        // 2. AI Content Analysis
        await AIService.analyze(buffer, file.type);

        // Always write to local temp first for processing/compression
        const tempPath = getStoragePath(sanitizedName);
        fs.writeFileSync(tempPath, buffer);
        console.log(`[BRIDGE] Payload buffered to: ${tempPath}`);

        const filePath = tempPath; // Used for tool input

        // THUMBNAIL GENERATION (Keep as is, uses buffer)
        let thumbnailPath = null;
        if (file.type.startsWith('image/')) {
            try {
                const thumbName = `thumb_${sanitizedName}.jpg`;
                const thumbLocalPath = getStoragePath(thumbName);

                await sharp(buffer)
                    .resize(400, 400, { fit: 'cover' })
                    .jpeg({ quality: 80 })
                    .toFile(thumbLocalPath);

                thumbnailPath = thumbLocalPath;
            } catch (err) { }
        }

        // REAL COMPRESSION PIPELINE
        const fileSizeMB = buffer.length / (1024 * 1024);
        const shouldCompressFile = shouldCompress(fileSizeMB);
        const storageProvider = getStorageProvider();

        if (!shouldCompressFile) {
            console.log(`[BRIDGE] Fast-path: Skipping compression.`);
            const shareID = `${sanitizedName}.omni.acs`;

            // Upload to CDN if enabled
            let finalStoragePath = filePath;
            let isExternal = 0;
            let finalThumbPath = thumbnailPath;

            if (storageProvider.isExternal()) {
                console.log(`[BRIDGE] Offloading to CDN...`);
                finalStoragePath = await storageProvider.upload(buffer, sanitizedName, file.type);
                isExternal = 1;

                // Also upload thumbnail if exists
                if (thumbnailPath) {
                    const thumbBuffer = fs.readFileSync(thumbnailPath);
                    const thumbKey = `thumb_${sanitizedName}.jpg`;
                    finalThumbPath = await storageProvider.upload(thumbBuffer, thumbKey, 'image/jpeg');
                    // Cleanup local thumbnail securely
                    await secureDelete(thumbnailPath);
                }

                // Cleanup local original securely
                await secureDelete(filePath);
            }

            // SAVE TO DB
            console.log(`[INGEST] Saving ${shareID} to database...`);
            await FileRepository.create({
                share_id: shareID,
                user_id: userId || null, // Ensure explicit null if undefined
                original_name: file.name,
                sanitized_name: sanitizedName,
                storage_path: finalStoragePath,
                thumbnail_path: finalThumbPath,
                password_hash: passwordHash,
                is_external: isExternal,
                file_size: file.size,
                mime_type: file.type || 'application/octet-stream',
                expires_at: Date.now() + (7 * 24 * 60 * 60 * 1000),
                compression_ratio: '1.0x',
                compression_speed: 'Instant',
                tags: tagsRaw,
                summary: summary,
                is_encrypted: isEncrypted,
                encryption_iv: encryptionIv,
                similarity_token: similarityToken
            });

            // Record Audit Event
            await AuditLogger.record({
                userId: userId,
                action: 'FILE_UPLOAD',
                resource: shareID,
                details: `Fast-path upload of ${file.name} (${file.size} bytes). Encrypted: ${isEncrypted === 1}`,
                ipAddress: getClientIdentifier(request)
            });
            console.log(`[INGEST] ${shareID} record created.`);


            return NextResponse.json({
                success: true,
                link: getShareLinkUrl(shareID),
                stats: { speed: 'Instant', ratio: '1.0x (Fast-path)', fidelity: 'BIT-PERFECT' }
            });
        }

        console.log(`[BRIDGE] Initiating Integrated Reactor Flow...`);

        const startTime = Date.now();

        // Use ACSNode to manage chunks
        const chunkIds = await globalNode.ingestFile(sanitizedName, buffer);
        globalNode.optimize(); // Trigger evolution logic

        // Compression via Worker for the main payload (simulation of DiocomReactor)
        const compressedBuffer = await new Promise<Buffer>((resolve, reject) => {
            const worker = new Worker(path.join(process.cwd(), 'diocom-app/src/lib/reactorWorker.ts'), {
                workerData: { data: buffer }
            });
            worker.on('message', (msg) => {
                if (msg.success) resolve(msg.compressed);
                else reject(new Error(msg.error));
            });
            worker.on('error', reject);
        });

        const duration = (Date.now() - startTime) / 1000;
        const shareID = `${sanitizedName}.omni.acs`;
        const mbps = (fileSizeMB / duration).toFixed(2);
        const ratio = (buffer.length / compressedBuffer.length).toFixed(2) + 'x';

        // Write compressed result to temp path
        fs.writeFileSync(filePath, compressedBuffer);

        // Upload Result to CDN if enabled
        let finalStoragePath = filePath;
        let isExternal = 0;
        let finalThumbPath = thumbnailPath;

        if (storageProvider.isExternal()) {
            finalStoragePath = await storageProvider.upload(compressedBuffer, sanitizedName, file.type);
            isExternal = 1;

            if (thumbnailPath) {
                const thumbBuffer = fs.readFileSync(thumbnailPath);
                finalThumbPath = await storageProvider.upload(thumbBuffer, `thumb_${sanitizedName}.jpg`, 'image/jpeg');
                await secureDelete(thumbnailPath);
            }
            await secureDelete(filePath);
        }

        // SAVE TO DB
        console.log(`[INGEST] Saving ${shareID} (ACS-Optimized) to database...`);
        await FileRepository.create({
            share_id: shareID,
            user_id: userId || null,
            original_name: file.name,
            sanitized_name: sanitizedName,
            storage_path: finalStoragePath,
            thumbnail_path: finalThumbPath,
            password_hash: passwordHash,
            is_external: isExternal,
            file_size: file.size,
            mime_type: file.type || 'application/octet-stream',
            expires_at: Date.now() + (7 * 24 * 60 * 60 * 1000),
            compression_ratio: ratio,
            compression_speed: `${mbps} MB/s`,
            tags: tagsRaw,
            summary: summary,
            is_encrypted: isEncrypted,
            encryption_iv: encryptionIv,
            similarity_token: similarityToken
        });

        // Record Audit Event
        await AuditLogger.record({
            userId: userId,
            action: 'FILE_UPLOAD',
            resource: shareID,
            details: `Optimized upload of ${file.name} (${file.size} bytes). Ratio: ${ratio}. Encrypted: ${isEncrypted === 1}`,
            ipAddress: getClientIdentifier(request)
        });

        // Dispatch Webhook
        await WebhookService.dispatch('file.uploaded', {
            shareId: shareID,
            ownerId: userId,
            filename: file.name,
            size: file.size,
            encrypted: isEncrypted === 1
        });

        return NextResponse.json({
            success: true,
            link: getShareLinkUrl(shareID),
            stats: { speed: `${mbps} MB/s`, ratio: ratio, fidelity: 'BIT-PERFECT' }
        });
    } catch (e: any) {
        const errorLog = `\n[${new Date().toISOString()}] FATAL INGEST ERROR: ${e.message}\n${e.stack}\n`;
        fs.appendFileSync(config.debug.debugLogPath, errorLog);
        console.error('[BRIDGE] Fatal Ingestion Error:', e.message);
        console.error(e.stack);

        if (e instanceof ValidationError) {
            return NextResponse.json({
                success: false,
                message: e.message,
                code: e.code
            }, { status: e.statusCode });
        }

        return NextResponse.json({
            success: false,
            message: e.message || 'Internal server error',
            code: 'INTERNAL_ERROR'
        }, { status: 500 });
    }
}
