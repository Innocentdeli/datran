import { Loader2 } from 'lucide-react';

export default function Loading() {
  return (
    <div className="bg-mesh flex min-h-dvh items-center justify-center" role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
        <p className="text-sm text-gray-300">Loading…</p>
      </div>
    </div>
  );
}
