
declare module 'brotli' {
    export function compress(data: Buffer, options?: any): Uint8Array;
    export function decompress(data: Buffer, size?: number): Uint8Array;
}

declare module 'lz4js' {
    export function compress(data: Buffer, options?: any): Uint8Array;
    export function decompress(data: Buffer): Uint8Array;
}
