import { Activity } from 'lucide-react';
import { PageProtocolBadge } from '@/components/features/ConnectionInfo';

export default function Footer() {
  return (
    <div className="mt-20 py-8 w-full border-t border-white/5 flex flex-col sm:flex-row items-center justify-between gap-6 text-gray-500">
      <div className="flex items-center gap-2">
        <Activity className="w-4 h-4 text-primary/50" />
        <PageProtocolBadge className="text-[10px] uppercase tracking-widest font-medium" />
      </div>
      <p className="text-[10px] uppercase tracking-widest font-medium">© 2026 Datran</p>
    </div>
  );
}
