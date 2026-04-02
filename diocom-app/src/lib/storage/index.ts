import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { config } from '@/config';

// Interface
export interface StorageProvider {
    upload(buffer: Buffer, key: string, contentType: string): Promise<string>; // Returns path or URL
    isExternal(): boolean;
}

// Local Provider
export const LocalStorage: StorageProvider = {
    upload: async (buffer, key, contentType) => {
        // We use key as filename usually, logic might vary
        // Re-using logic from config.getStoragePath would be ideal but circular dep risk
        // We accept simplified key here
        const uploadDir = path.join(process.cwd(), 'data', 'uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        const filePath = path.join(uploadDir, key);
        fs.writeFileSync(filePath, buffer);
        return filePath;
    },
    isExternal: () => false
};

// S3 Provider
export const S3Storage: StorageProvider = {
    upload: async (buffer, key, contentType) => {
        const client = new S3Client({
            region: process.env.S3_REGION || 'us-east-1',
            credentials: {
                accessKeyId: process.env.S3_ACCESS_KEY || '',
                secretAccessKey: process.env.S3_SECRET_KEY || ''
            }
        });

        const bucket = process.env.S3_BUCKET || 'diocom-uploads';

        await client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: buffer,
            ContentType: contentType,
            // ACL: 'public-read' // Optional depending on bucket policy
        }));

        // Return public URL or internal S3 URI
        // For simplicity returning public URL format
        return `https://${bucket}.s3.amazonaws.com/${key}`;
    },
    isExternal: () => true
};

// Factory
export function getStorageProvider(): StorageProvider {
    if (process.env.CDN_ENABLED === 'true') {
        return S3Storage;
    }
    return LocalStorage;
}
