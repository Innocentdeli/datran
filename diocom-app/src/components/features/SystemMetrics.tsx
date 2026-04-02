import { Database, Cpu } from 'lucide-react';

export interface SystemMetricsProps {
  activeAtoms?: boolean;
  meshNodes?: number;
  weissmanScore?: number;
}

export default function SystemMetrics({
  activeAtoms = true,
  meshNodes = 411,
  weissmanScore = 59.04,
}: SystemMetricsProps) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
      <div className="glass p-4 sm:p-6 border-none bg-white/5">
        <div className="flex items-center gap-2 mb-1">
          <Database className="w-3 h-3 text-gray-500" />
          <span className="text-[9px] text-gray-500 uppercase font-bold">
            Atoms
          </span>
        </div>
        <span className="text-sm font-bold text-white tracking-tight">
          {activeAtoms ? 'Active' : 'Idle'}
        </span>
      </div>

      <div className="glass p-4 sm:p-6 border-none bg-white/5">
        <div className="flex items-center gap-2 mb-1">
          <Cpu className="w-3 h-3 text-gray-500" />
          <span className="text-[9px] text-gray-500 uppercase font-bold">
            Mesh
          </span>
        </div>
        <span className="text-sm font-bold text-white tracking-tight">
          {meshNodes} Nodes
        </span>
      </div>

      <div className="glass p-4 sm:p-6 border-none bg-primary/5 border border-primary/20 col-span-2 lg:col-span-1">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[9px] text-primary uppercase font-bold">
            Weissman
          </span>
        </div>
        <span className="text-lg sm:text-xl font-black text-primary italic">
          {weissmanScore.toFixed(2)}
        </span>
      </div>
    </div>
  );
}
