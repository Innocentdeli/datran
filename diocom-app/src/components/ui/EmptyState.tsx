import { HTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { LucideIcon } from 'lucide-react';
import Button from './Button';

export interface EmptyStateProps extends HTMLAttributes<HTMLDivElement> {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(
  (
    {
      className,
      icon: Icon,
      title,
      description,
      action,
      ...props
    },
    ref
  ) => {
    return (
      <div
        ref={ref}
        className={cn(
          'flex flex-col items-center justify-center text-center p-12',
          className
        )}
        {...props}
      >
        {Icon && (
          <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4 border border-white/10">
            <Icon className="w-8 h-8 text-gray-500" />
          </div>
        )}
        
        <h3 className="text-xl font-bold mb-2 text-gray-300">{title}</h3>
        
        {description && (
          <p className="text-sm text-gray-500 max-w-md mb-6">{description}</p>
        )}
        
        {action && (
          <Button onClick={action.onClick} variant="primary" size="md">
            {action.label}
          </Button>
        )}
      </div>
    );
  }
);

EmptyState.displayName = 'EmptyState';

export default EmptyState;
