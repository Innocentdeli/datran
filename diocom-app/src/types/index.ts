export interface LogEntry {
  type: 'system' | 'swarm' | 'reactor' | 'engine' | 'user' | 'error' | 'neural';
  message: string;
  timestamp: Date;
}

export interface CompressionStats {
  speed: string;
  ratio: string;
  fidelity: string;
}

export interface FileUploadState {
  file: File | null;
  progress: number;
  isProcessing: boolean;
  error: string | null;
}
