import { forwardRef, ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
  size?: 'sm' | 'md' | 'lg';
}

/** Shared class list so links styled as buttons (`<Link className={buttonClasses(...)}>`) match exactly. */
export function buttonClasses(variant: ButtonProps['variant'] = 'primary', size: ButtonProps['size'] = 'md', className?: string) {
  return cn(
    'inline-flex items-center justify-center gap-2 font-semibold rounded-xl transition-colors select-none',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
    'disabled:opacity-50 disabled:cursor-not-allowed',
    {
      'bg-primary text-on-primary hover:bg-primary-light shadow-[0_0_24px_rgba(0,242,255,0.25)]': variant === 'primary',
      'bg-white/10 text-white hover:bg-white/15 border border-white/10': variant === 'secondary',
      'bg-transparent text-gray-200 hover:bg-white/5 hover:text-white': variant === 'ghost',
      'bg-red-600 text-white hover:bg-red-500': variant === 'danger',
      'bg-emerald-600 text-white hover:bg-emerald-500': variant === 'success',
    },
    {
      'h-9 px-3.5 text-xs': size === 'sm',
      'h-11 px-5 text-sm': size === 'md',
      'h-13 px-7 text-base': size === 'lg',
    },
    className
  );
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', children, ...props }, ref) => {
    return (
      <button ref={ref} className={buttonClasses(variant, size, className)} {...props}>
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';

export default Button;
