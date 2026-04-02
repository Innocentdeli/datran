
export interface ACSConfig {
    // Network
    defaultBandwidthOps: number; // bytes/ms

    // Ingestion
    initialChunkSize: number; // bytes

    // Replication & Gravity
    replicationThreshold: number; // requests per window
    migrationThreshold: number; // total requests
    gravityRatio: number; // 0.0 - 1.0 (percent of requests from region)

    // Evolution & Decay
    decayHoursStart: number;
    decayHoursCritical: number;
    requestsBetweenEvo: number;

    // Context Penalties
    mobileCpuPenalty: number;
    desktopCpuPenalty: number;
    vrCpuPenalty: number;
    spaceBandwidthPenalty: number;
    spaceWeissmanBoost: number;

    // Quality & Fidelity
    defaultBrotliQuality: number;
    highDensityBrotliQuality: number;
    defaultQualityFidelity: number;
    upscaleRatio: number;
    cinemaQualityThreshold: number;
    cinemaScoreBoost: number;

    // Evolutionary Thresholds
    biodiversityFloor: number;
    generativeEntropyThreshold: number;
    observationAlpha: number; // Smoothing factor for discovery

    // Scoring & Benchmarks
    baseScoreUnit: number;
    gzipRatioBaseline: number;
    gzipTimeBaselineMs: number;
}

export const DEFAULT_CONFIG: ACSConfig = {
    defaultBandwidthOps: 500,
    initialChunkSize: 1024 * 1024,
    replicationThreshold: 5,
    migrationThreshold: 20,
    gravityRatio: 0.8,
    decayHoursStart: 24,
    decayHoursCritical: 168,
    requestsBetweenEvo: 20,
    mobileCpuPenalty: 3,
    desktopCpuPenalty: 0.5,
    vrCpuPenalty: 20,
    spaceBandwidthPenalty: 50,
    spaceWeissmanBoost: 2.0,
    defaultBrotliQuality: 5,
    highDensityBrotliQuality: 11,
    defaultQualityFidelity: 0.8,
    upscaleRatio: 2.0,
    cinemaQualityThreshold: 0.9,
    cinemaScoreBoost: 1000000,
    biodiversityFloor: 0.7,
    generativeEntropyThreshold: 0.5,
    observationAlpha: 0.2,
    baseScoreUnit: 10000,
    gzipRatioBaseline: 2.5,
    gzipTimeBaselineMs: 10
};
