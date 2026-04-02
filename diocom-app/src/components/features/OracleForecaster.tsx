
'use client';

import { motion } from 'framer-motion';
import { Brain, Globe, Zap, TrendingUp } from 'lucide-react';
import { useEffect, useState } from 'react';

interface Prediction {
  region: string;
  confidence: number;
  chunkId: string;
}

export default function OracleForecaster() {
  const [predictions, setPredictions] = useState<Prediction[]>([
    { region: 'EU-WEST', confidence: 0.92, chunkId: 'df82a1' },
    { region: 'US-EAST', confidence: 0.78, chunkId: 'acb212' },
    { region: 'ASIA-PAC', confidence: 0.45, chunkId: '09fb2a' },
  ]);

  const [cacheHits, setCacheHits] = useState(124);

  useEffect(() => {
    const interval = setInterval(() => {
      setCacheHits(prev => prev + (Math.random() > 0.7 ? 1 : 0));
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Brain className="w-5 h-5 text-primary" />
          <h3 className="text-sm font-bold uppercase tracking-widest text-white/90">The Oracle</h3>
        </div>
        <div className="flex items-center gap-2 bg-primary/10 px-3 py-1 rounded-full border border-primary/20">
          <TrendingUp className="w-3 h-3 text-primary" />
          <span className="text-[10px] font-mono text-primary font-bold">{cacheHits} Proactive Hits</span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2">
        {predictions.map((pred, i) => (
          <motion.div
            key={pred.chunkId}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.1 }}
            className="glass p-3 flex items-center justify-between bg-white/[0.02] border-white/5 hover:bg-white/[0.04] transition-colors group"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-black/40 flex items-center justify-center border border-white/10 group-hover:border-primary/30 transition-colors">
                <Globe className="w-4 h-4 text-gray-500 group-hover:text-primary transition-colors" />
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] font-bold text-gray-400 group-hover:text-gray-300 transition-colors uppercase tracking-tight">
                  {pred.region}
                </span>
                <span className="text-[9px] font-mono text-gray-600">
                  Chunk: {pred.chunkId}
                </span>
              </div>
            </div>

            <div className="flex flex-col items-end gap-1">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-primary font-black">
                  {(pred.confidence * 100).toFixed(0)}%
                </span>
                <div className="w-16 h-1 bg-white/5 rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-primary shadow-[0_0_8px_rgba(59,130,246,0.5)]"
                    initial={{ width: 0 }}
                    animate={{ width: `${pred.confidence * 100}%` }}
                    transition={{ duration: 1, delay: i * 0.1 }}
                  />
                </div>
              </div>
              <span className="text-[8px] text-gray-600 uppercase font-bold tracking-tighter">Confidence Score</span>
            </div>
          </motion.div>
        ))}
      </div>

      <div className="mt-2 glass p-4 bg-primary/[0.03] border-primary/10 flex items-center gap-4">
        <div className="w-10 h-10 rounded-full border-2 border-dashed border-primary/30 flex items-center justify-center animate-spin-slow">
           <Zap className="w-5 h-5 text-primary" />
        </div>
        <div className="flex flex-col">
          <span className="text-xs font-bold text-white">Hyper-Acceleration Active</span>
          <p className="text-[10px] text-gray-400 leading-tight">
            The Oracle is currently hot-pushing predicted fragments to edge nodes globally.
          </p>
        </div>
      </div>
    </div>
  );
}
