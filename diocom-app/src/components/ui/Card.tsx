import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface CardProps {
  children: ReactNode;
  variant?: 'glass' | 'solid' | 'outline';
  padding?: 'none' | 'sm' | 'md' | 'lg';
  className?: string;
}

export default function Card({
  children,
  variant = 'glass',
  padding = 'md',
  className,
}: CardProps) {
  return (
    <div
      className={cn(
        'rounded-2xl transition-all',
        {
          'glass': variant === 'glass',
          'bg-gray-900 border border-gray-800': variant === 'solid',
          'border border-white/10': variant === 'outline',
        },
        {
          'p-0': padding === 'none',
          'p-4': padding === 'sm',
          'p-6': padding === 'md',
          'p-8': padding === 'lg',
        },
        className
      )}
    >
      {children}
    </div>
  );
}
