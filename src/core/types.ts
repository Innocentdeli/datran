
// 'ai-upscale' and 'generative' are simulation-only and NOT reversible; they are never produced
// unless GenomeGenerator is explicitly asked for simulated variants.
export type CompressionAlgorithm = 'raw' | 'zstd' | 'brotli' | 'lz4' | 'reactor' | 'ai-upscale' | 'generative';

export type ClientContext = 'mobile' | 'desktop' | 'server' | 'space' | 'vr' | 'cinema';

export interface Peer {
    id: string;
    region: string;
    latency: number;
    reliability: number;
}

export interface NetworkMessage {
    type: 'REQUEST' | 'REPLICATE' | 'MIGRATE';
    chunkId: string;
    payload?: Buffer;
    sourcePeerId: string;
}

export interface FitnessProfile {
    decodeTime: number;
    transferTime: number;
    size: number;
    cpuCost: number;
    accessCount: number;
    lastAccessed: number;
}

export interface Variant {
    id: string;
    chunkId: string;
    algorithm: CompressionAlgorithm;
    settings: Record<string, any>;
    data: Buffer;
    quality: number; // 0.0 - 1.0
    fitness: FitnessProfile;
}

export interface Chunk {
    id: string;
    originalSize: number;
    variants: Variant[];
    bestVariantId?: string;
}

export interface Genome {
    chunks: Map<string, Chunk>;
}
