import fs from 'fs';
import crypto from 'crypto';

/**
 * Datran Cryptographic Shredder (Zero-Trace Deletion)
 * 
 * Securely deletes a file from the physical disk by overwriting
 * the allocated bytes multiple times before unlinking the inode.
 * This makes forensic data recovery practically impossible.
 */
export async function secureDelete(filePath: string, passes: number = 3): Promise<void> {
    if (!fs.existsSync(filePath)) return;

    const stats = fs.statSync(filePath);
    const fileSize = stats.size;

    // Pass 1: Overwrite with Zeros (0x00)
    const fd = fs.openSync(filePath, 'r+');
    const zeroBuffer = Buffer.alloc(fileSize, 0x00);
    fs.writeSync(fd, zeroBuffer, 0, fileSize, 0);
    fs.fdatasyncSync(fd);

    // Pass 2: Overwrite with Ones (0xFF)
    if (passes >= 2) {
        const oneBuffer = Buffer.alloc(fileSize, 0xFF);
        fs.writeSync(fd, oneBuffer, 0, fileSize, 0);
        fs.fdatasyncSync(fd);
    }

    // Pass 3: Overwrite with Cryptographically Secure Pseudo-Random Noise
    if (passes >= 3) {
        // For very large files, this would be done in chunks, but for Datran temp chunks, this is fine
        const randBuffer = crypto.randomBytes(fileSize);
        fs.writeSync(fd, randBuffer, 0, fileSize, 0);
        fs.fdatasyncSync(fd);
    }

    fs.closeSync(fd);

    // Finally, unlink the inode
    fs.unlinkSync(filePath);
    console.log(`[SHREDDER] ☢️ File at ${filePath} cryptographically shredded.`);
}
