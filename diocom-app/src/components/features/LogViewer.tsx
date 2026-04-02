'use client';

import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Activity } from 'lucide-react';
import { LogEntry } from '@/types';
import { cn } from '@/lib/utils';

export interface LogViewerProps {
  logs: LogEntry[];
  maxVisible?: number;
  autoScroll?: boolean;
}

const logTypeColors = {
  system: 'text-blue-400',
  swarm: 'text-purple-400',
  reactor: 'text-primary',
  engine: 'text-green-400',
  user: 'text-yellow-400',
  error: 'text-red-400',
  neural: 'text-cyan-400',
};

export default function LogViewer({
  logs,
  maxVisible = 8,
  autoScroll = true,
}: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const visibleLogs = logs.slice(-maxVisible);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 mb-4 sm:mb-6">
        <Activity className="w-3 h-3 text-primary animate-pulse" />
        <h3 className="text-[10px] font-bold uppercase tracking-[0.3em] text-primary/50">
          Live Status HUD
        </h3>
      </div>

      <div
        ref={containerRef}
        className="flex-1 font-mono text-[10px] space-y-2 overflow-y-auto italic leading-relaxed bg-black/20 p-4 rounded-xl border border-white/5 scrollbar-hidden"
      >
        {visibleLogs.map((log, i) => (
          <motion.p
            initial={{ opacity: 0, x: -5 }}
            animate={{ opacity: 1, x: 0 }}
            key={`${log.timestamp.getTime()}-${i}`}
            className={cn('transition-colors', logTypeColors[log.type])}
          >
            [{log.type.toUpperCase()}] {log.message}
          </motion.p>
        ))}
      </div>
    </div>
  );
}
