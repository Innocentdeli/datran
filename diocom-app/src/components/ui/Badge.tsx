import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface BadgeProps {
  children: ReactNode;
  variant?: 'primary' | 'success' | 'warning' | 'error' | 'neutral';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export default function Badge({
  children,
  variant = 'neutral',
  size = 'md',
  className,
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 font-bold uppercase tracking-wider rounded-full',
        {
          'bg-primary/10 text-primary border border-primary/20': variant === 'primary',
          'bg-green-500/10 text-green-400 border border-green-500/20': variant === 'success',
          'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20': variant === 'warning',
          'bg-red-500/10 text-red-400 border border-red-500/20': variant === 'error',
          'bg-white/5 text-gray-400 border border-white/10': variant === 'neutral',
        },
        {
          'px-2 py-0.5 text-[9px]': size === 'sm',
          'px-3 py-1 text-[10px]': size === 'md',
          'px-4 py-1.5 text-xs': size === 'lg',
        },
        className
      )}
    >
      {children}
    </span>
  );
}
