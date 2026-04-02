
import { Chunk, Genome, Variant, ClientContext } from '../core/types';
import { GenomeGenerator } from '../core/GenomeGenerator';
import { EvolutionManager } from '../evolution/EvolutionManager';
import { FitnessEvaluator } from '../evolution/FitnessEvaluator';
import { ChunkGraph } from './ChunkGraph';
import { ChunkFuser } from './ChunkFuser';
import { ReplicationManager } from './ReplicationManager';
import { HybridIndex } from '../core/HybridIndex';
import { ACSConfig, DEFAULT_CONFIG } from '../core/SystemConfig';
import { ConfigMutator } from '../evolution/ConfigMutator';
import { TemporalPredictor } from '../intelligence/TemporalPredictor';
import { ChunkRepository, VariantRepository } from '../../diocom-app/src/db/files'; // Linking app DB
import * as crypto from 'crypto';
import { SwarmEdgeService, EdgeRegion } from './SwarmEdgeService';
import { Prediction } from '../intelligence/TemporalPredictor';

export class ACSNode {
    public id: string = crypto.randomUUID().substring(0, 8);
    public region: string = 'server';
    public genome: Genome = { chunks: new Map() };
    public index: HybridIndex;
    public evolutionManager: EvolutionManager;
    public replicationManager: ReplicationManager;
    public chunkGraph: ChunkGraph;
    public config: ACSConfig;
    public temporalPredictor: TemporalPredictor;
    public edgeService = SwarmEdgeService.getInstance();

    private memoryCache: Map<string, Buffer> = new Map();

    private performanceHistory: number[] = [];
    private backupConfig?: ACSConfig;
    private isTestingMutation: boolean = false;
    private requestsSinceEvo = 0;
    private lastBaselineLatency?: number;

    constructor(region: string = 'server', config?: Partial<ACSConfig>) {
        this.region = region;
        this.config = { ...DEFAULT_CONFIG, ...config };

        this.evolutionManager = new EvolutionManager(this.config);
        this.chunkGraph = new ChunkGraph();
        this.replicationManager = new ReplicationManager(this);
        this.index = new HybridIndex(this);
        this.temporalPredictor = new TemporalPredictor();

        // Activate Mesh Resilience
        this.replicationManager.startResilienceLoop();
    }

    public async ingestFile(filename: string, data: Buffer): Promise<string[]> {
        const CHUNK_SIZE = this.config.initialChunkSize;

        const chunkIds: string[] = [];
        for (let i = 0; i < data.length; i += CHUNK_SIZE) {
            const slice = data.subarray(i, i + CHUNK_SIZE);
            const sliceHash = crypto.createHash('sha256').update(slice).digest('hex');

            // Check if chunk exists in DB
            let chunkId = sliceHash; // Simple mapping for now
            if (!this.genome.chunks.has(chunkId)) {
                // Persistent check
                const existingChunk = await ChunkRepository.findById(chunkId) as any;
                if (existingChunk) {
                    // Load variants from DB
                    const variants = await VariantRepository.findByChunkId(chunkId);
                    this.genome.chunks.set(chunkId, {
                        id: chunkId,
                        originalSize: existingChunk.original_size,
                        variants: variants,
                        bestVariantId: variants[0]?.id
                    });
                } else {
                    // New chunk
                    const variants: Variant[] = [
                        (GenomeGenerator as any)['createVariant'](chunkId, 'raw', {}, slice)
                    ];
                    await ChunkRepository.create({ id: chunkId, original_size: slice.length, hash: sliceHash });
                    await VariantRepository.create(variants[0]);

                    const chunk: Chunk = {
                        id: chunkId, originalSize: slice.length, variants: variants, bestVariantId: variants[0].id
                    };
                    this.genome.chunks.set(chunkId, chunk);
                }
            }
            chunkIds.push(chunkId);
        }
        return chunkIds;
    }

    public async mutate() {
        const chunks = Array.from(this.genome.chunks.values());
        if (chunks.length === 0) return;
        const chunk = chunks[Math.floor(Math.random() * chunks.length)];
        const raw = chunk.variants.find(v => v.algorithm === 'raw') || chunk.variants[0];
        const fullVariants = GenomeGenerator.generateVariants(chunk.id, raw.data, this.config);
        
        for (const v of fullVariants) {
            if (!chunk.variants.find(ex => ex.algorithm === v.algorithm)) {
                chunk.variants.push(v);
                await VariantRepository.create(v); // Persist mutation
            }
        }
    }

    public checkFusing(chunkId: string) {
        const neighbors = this.chunkGraph.getCorrelatedChunks(chunkId);
        if (neighbors.length === 0) return;
        const topNeighborId = neighbors[0];
        const chunkA = this.genome.chunks.get(chunkId);
        const chunkB = this.genome.chunks.get(topNeighborId);
        if (chunkA && chunkB) {
            // console.log(`[Self-Rewriting] 🧬 Fused ${chunkId.substr(0,4)}+${topNeighborId.substr(0,4)}`);
        }
    }

    public attemptSelfImprovement() {
        const avgLatency = this.performanceHistory.length > 0
            ? this.performanceHistory.reduce((a, b) => a + b, 0) / this.performanceHistory.length
            : 1000;
        this.performanceHistory = [];

        if (this.isTestingMutation) {
            if (avgLatency < (this.lastBaselineLatency || 999999)) {
                this.backupConfig = undefined;
                this.lastBaselineLatency = avgLatency;
            } else {
                if (this.backupConfig) {
                    this.config = { ...this.backupConfig };
                    this.backupConfig = undefined;
                }
            }
            this.isTestingMutation = false;
        } else {
            this.lastBaselineLatency = avgLatency;
            this.backupConfig = { ...this.config };
            this.config = ConfigMutator.mutate(this.config);
            this.isTestingMutation = true;
        }
    }

    public runOracleLoop(virtualTime?: number) {
        const now = virtualTime || Date.now();
        const predictions = this.temporalPredictor.predictNeeds(now);

        if (predictions.length > 0) {
            console.log(`[The Oracle] 🔮 Predicting ${predictions.length} chunks needed next hour...`);
            predictions.forEach((pred) => {
                const chunk = this.genome.chunks.get(pred.chunkId);
                if (chunk) {
                    const variant = chunk.variants.find(v => v.id === chunk.bestVariantId) || chunk.variants[0];
                    
                    // 1. Pre-decode to RAM
                    this.memoryCache.set(pred.chunkId, variant.data);
                    console.log(`[The Oracle] ⚡ Pre-Decoded Chunk ${pred.chunkId.substring(0, 8)} to RAM (Confidence: ${(pred.confidence * 100).toFixed(1)}%).`);
                    
                    // 2. Proactive Edge Cache
                    this.edgeService.cache(pred.chunkId, variant.data, pred.targetRegion as EdgeRegion);
                }
            });
        }
    }

    public async requestChunk(chunkId: string, prevChunkId?: string, context: ClientContext = 'server', virtualTime?: number): Promise<{ data: Buffer, timeMs: number }> {
        const chunk = this.genome.chunks.get(chunkId);
        if (!chunk) throw new Error(`Chunk ${chunkId} not found`);

        // Record for future prediction
        this.temporalPredictor.recordAccess(chunkId, virtualTime || Date.now(), this.region);

        if (prevChunkId) {
            this.chunkGraph.recordTransition(prevChunkId, chunkId);
            if (Math.random() > 0.5) this.checkFusing(prevChunkId);
        }

        let timeMs = 0;
        let decoded: Buffer;

        // 1. Check RAM Cache (Fastest)
        if (this.memoryCache.has(chunkId)) {
            decoded = this.memoryCache.get(chunkId)!;
            timeMs = 0.05; // Hit cost
            console.log(`[ACS] ⚡ RAM Hit: ${chunkId.substring(0,8)}`);
        } 
        // 2. Check Edge Cache (Second Fastest)
        else {
            const edgeData = this.edgeService.get(chunkId, this.region as EdgeRegion);
            if (edgeData) {
                decoded = edgeData;
                timeMs = 5.0; // Simulated latency
                console.log(`[ACS] 🌍 Edge Hit: ${chunkId.substring(0,8)} (${this.region.toUpperCase()})`);
            }
            // 3. Fallback to Origin
            else {
                let variant = chunk.variants.find(v => v.id === chunk.bestVariantId) || chunk.variants[0];
                const transferMs = variant.fitness.size / this.evolutionManager['bandwidthEstimate'];
                timeMs = transferMs + 0.1;
                decoded = variant.data;
            }
        }

        this.replicationManager.recordRequest(chunkId, context === 'mobile' ? 'mobile_network' : 'home_network');

        this.performanceHistory.push(timeMs);
        this.requestsSinceEvo++;
        if (this.requestsSinceEvo > this.config.requestsBetweenEvo) {
            this.attemptSelfImprovement();
            this.requestsSinceEvo = 0;
        }

        return { data: decoded, timeMs };
    }

    public optimize(context: ClientContext = 'server') {
        for (const chunk of this.genome.chunks.values()) {
            this.evolutionManager.evolve(chunk, context);
        }
    }
}
