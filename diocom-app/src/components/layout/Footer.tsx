import { ShieldCheck, Zap } from 'lucide-react';

export default function Footer() {
  return (
    <div className="mt-20 py-8 w-full border-t border-white/5 flex flex-col sm:flex-row items-center justify-between gap-6 text-gray-500">
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-success/50" />
          <span className="text-[10px] uppercase tracking-widest font-medium">Secure Encrypted Tunnel</span>
        </div>
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-primary/50" />
          <span className="text-[10px] uppercase tracking-widest font-medium">High Speed Optimization</span>
        </div>
      </div>
      <p className="text-[10px] uppercase tracking-widest font-medium">© 2026 Datran</p>
    </div>
  );
}
