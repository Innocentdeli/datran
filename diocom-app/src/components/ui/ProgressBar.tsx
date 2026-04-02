import { HTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils';

export interface ProgressBarProps extends HTMLAttributes<HTMLDivElement> {
  value: number;
  max?: number;
  variant?: 'primary' | 'success' | 'warning' | 'error';
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
  animated?: boolean;
}

const ProgressBar = forwardRef<HTMLDivElement, ProgressBarProps>(
  (
    {
      className,
      value,
      max = 100,
      variant = 'primary',
      size = 'md',
      showLabel = false,
      animated = true,
      ...props
    },
    ref
  ) => {
    const percentage = Math.min(Math.max((value / max) * 100, 0), 100);
    
    const variants = {
      primary: 'bg-primary shadow-[0_0_10px_rgba(0,242,255,0.5)]',
      success: 'bg-success shadow-[0_0_10px_rgba(0,255,136,0.5)]',
      warning: 'bg-warning shadow-[0_0_10px_rgba(255,170,0,0.5)]',
      error: 'bg-error shadow-[0_0_10px_rgba(255,51,102,0.5)]',
    };
    
    const sizes = {
      sm: 'h-1',
      md: 'h-2',
      lg: 'h-3',
    };
    
    return (
      <div ref={ref} className={cn('w-full', className)} {...props}>
        {showLabel && (
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-gray-400 font-mono">{Math.round(percentage)}%</span>
          </div>
        )}
        <div className={cn('w-full bg-white/5 rounded-full overflow-hidden', sizes[size])}>
          <div
            className={cn(
              'h-full rounded-full transition-all',
              variants[variant],
              animated && 'duration-500 ease-out'
            )}
            style={{ width: `${percentage}%` }}
          />
        </div>
      </div>
    );
  }
);

ProgressBar.displayName = 'ProgressBar';

export default ProgressBar;
