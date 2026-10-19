import { cn } from '@/lib/utils';

/** Datran logo tile. */
export default function BrandMark({ size = 'md' }: { size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid place-items-center rounded-xl bg-primary font-black text-on-primary shadow-[0_0_24px_rgba(0,242,255,0.25)]',
        size === 'sm' ? 'h-8 w-8 text-sm' : 'h-9 w-9 text-base'
      )}
    >
      D
    </span>
  );
}
