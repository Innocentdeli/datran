import { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface StatCardProps {
  label: string;
  value: string;
  icon: LucideIcon;
  variant?: 'primary' | 'success' | 'neutral' | 'warning';
  description?: string;
  className?: string;
}

export default function StatCard({
  label,
  value,
  icon: Icon,
  variant = 'neutral',
  description,
  className,
}: StatCardProps) {
  return (
    <div
      className={cn(
        'glass p-6 border-none',
        {
          'bg-primary/5 border border-primary/20': variant === 'primary',
          'bg-green-500/5 border border-green-500/20': variant === 'success',
          'bg-yellow-500/5 border border-yellow-500/20': variant === 'warning',
          'bg-white/5': variant === 'neutral',
        },
        className
      )}
    >
      <span className="text-[9px] text-gray-500 uppercase font-black tracking-widest block mb-2">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <Icon
          className={cn('w-4 h-4', {
            'text-primary': variant === 'primary',
            'text-green-400': variant === 'success',
            'text-yellow-400': variant === 'warning',
            'text-gray-400': variant === 'neutral',
          })}
        />
        <span className="text-sm font-bold uppercase italic">{value}</span>
      </div>
      {description && (
        <p className="text-[10px] text-gray-500 mt-1">{description}</p>
      )}
    </div>
  );
}
