import { AlertCircle, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Shimmering placeholder shown while a preview loads or decrypts. */
export function PreviewSkeleton({ label, className }: { label: string; className?: string }) {
    return (
        <div role="status" className={cn('skeleton flex items-center justify-center rounded-2xl', className)}>
            <span className="text-sm text-gray-400">{label}</span>
        </div>
    );
}

/** Graceful failure for a preview: the file can usually still be downloaded. */
export function PreviewError({ message, onRetry, className }: { message: string; onRetry?: () => void; className?: string }) {
    return (
        <div role="alert" className={cn('flex flex-col items-center justify-center gap-3 rounded-2xl border border-white/10 bg-black/30 p-6 text-center', className)}>
            <AlertCircle className="h-8 w-8 text-amber-300" aria-hidden="true" />
            <div>
                <p className="font-medium text-white">Preview unavailable</p>
                <p className="mt-1 max-w-md text-sm text-gray-300">{message}</p>
            </div>
            {onRetry ? (
                <button
                    type="button"
                    onClick={onRetry}
                    className="inline-flex h-9 items-center gap-2 rounded-xl border border-white/10 bg-white/10 px-3.5 text-xs font-semibold text-white hover:bg-white/15"
                >
                    <RotateCcw className="h-4 w-4" aria-hidden="true" /> Try again
                </button>
            ) : null}
        </div>
    );
}
