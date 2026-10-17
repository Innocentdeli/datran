/**
 * Datran Zero-Knowledge Encryption Core
 * 
 * Uses AES-GCM (Authenticated Encryption) for high-performance,
 * client-side security. The key never touches the server.
 */
import secrets from 'secrets.js-grempe';

export const ALGORITHM = 'AES-GCM';
export const KEY_LENGTH = 256;

/**
 * Helper to convert Uint8Array to base64url.
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * Helper to convert base64url to Uint8Array.
 */
export function base64UrlToBytes(base64url: string): Uint8Array {
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
    }
    return bytes;
}

/**
 * Generates a random 256-bit encryption key.
 */
export async function generateKey(): Promise<CryptoKey> {
    return await globalThis.crypto.subtle.generateKey(
        { name: ALGORITHM, length: KEY_LENGTH },
        true, // extractable
        ['encrypt', 'decrypt']
    );
}

/**
 * Exports a key to a base64 string for URL sharing.
 */
export async function exportKey(key: CryptoKey): Promise<string> {
    const exported = await globalThis.crypto.subtle.exportKey('raw', key);
    return btoa(String.fromCharCode(...new Uint8Array(exported)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * Imports a key from a base64 string.
 */
export async function importKey(keyStr: string): Promise<CryptoKey> {
    const base64 = keyStr.replace(/-/g, '+').replace(/_/g, '/');
    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
    }

    return await globalThis.crypto.subtle.importKey(
        'raw',
        bytes,
        { name: ALGORITHM },
        true,
        ['encrypt', 'decrypt']
    );
}

/**
 * Shamir's Secret Sharing: Splits the key into N shares, requiring K to reconstruct.
 */
export async function splitKey(key: CryptoKey, shares: number = 3, threshold: number = 2): Promise<string[]> {
    const exported = await globalThis.crypto.subtle.exportKey('raw', key);
    const hex = Array.from(new Uint8Array(exported))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    return secrets.share(secrets.str2hex(hex), shares, threshold);
}

/**
 * Shamir's Secret Sharing: Combines shares back into the CryptoKey.
 */
export async function combineKey(shares: string[]): Promise<CryptoKey> {
    const combinedHex = secrets.combine(shares);
    const originalHex = secrets.hex2str(combinedHex);
    const bytes = new Uint8Array(originalHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    
    return await globalThis.crypto.subtle.importKey(
        'raw',
        bytes,
        { name: ALGORITHM },
        true,
        ['encrypt', 'decrypt']
    );
}

/**
 * Encrypts a File into an ArrayBuffer.
 * Returns { encryptedData: ArrayBuffer, iv: Uint8Array }
 */
export async function encryptFile(file: File, key: CryptoKey): Promise<{ encryptedData: ArrayBuffer, iv: Uint8Array }> {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12)); // GCM standard IV size
    const fileBuffer = await file.arrayBuffer();

    const encryptedData = await globalThis.crypto.subtle.encrypt(
        { name: ALGORITHM, iv: iv as Uint8Array<ArrayBuffer> },
        key,
        fileBuffer
    );

    return { encryptedData: encryptedData as ArrayBuffer, iv };
}

/**
 * Decrypts an ArrayBuffer.
 */
export async function decryptBuffer(data: ArrayBuffer, key: CryptoKey, iv: Uint8Array): Promise<ArrayBuffer> {
    return (await globalThis.crypto.subtle.decrypt(
        { name: ALGORITHM, iv: iv as Uint8Array<ArrayBuffer> },
        key,
        data
    )) as ArrayBuffer;
}
