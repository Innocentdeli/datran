'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import Button, { buttonClasses } from '@/components/ui/Button';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[DIOCOM ERROR]', error);
  }, [error]);

  return (
    <main className="bg-mesh flex min-h-dvh items-center justify-center p-4 sm:p-8">
      <div role="alert" className="panel w-full max-w-md p-8 text-center">
        <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-red-400/25 bg-red-500/10 text-red-300" aria-hidden="true">
          <AlertCircle className="h-7 w-7" />
        </span>
        <h1 className="mb-2 text-xl font-semibold text-white">Something went wrong</h1>
        <p className="mb-6 text-sm text-gray-300">
          {error.message || 'An unexpected error occurred while loading this page.'}
          {error.digest ? <span className="mt-2 block font-mono text-xs text-gray-400">Reference: {error.digest}</span> : null}
        </p>
        <div className="flex flex-col justify-center gap-2 sm:flex-row">
          <Button onClick={reset}>Try again</Button>
          <Link href="/" className={buttonClasses('secondary', 'md')}>Go home</Link>
        </div>
      </div>
    </main>
  );
}
