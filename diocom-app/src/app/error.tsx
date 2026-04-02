'use client';

import { useEffect } from 'react';
import { AlertCircle } from 'lucide-react';
import Button from '@/components/ui/Button';

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
    <div className="min-h-screen bg-mesh text-white flex items-center justify-center p-8">
      <div className="max-w-md w-full glass p-8 text-center">
        <div className="w-16 h-16 rounded-full bg-error/10 flex items-center justify-center mx-auto mb-4 border border-error/20">
          <AlertCircle className="w-8 h-8 text-error" />
        </div>
        
        <h2 className="text-2xl font-black uppercase italic tracking-tighter mb-2">
          System Error
        </h2>
        
        <p className="text-sm text-gray-400 mb-6">
          {error.message || 'Something went wrong with the compression swarm.'}
        </p>
        
        <div className="flex gap-3 justify-center">
          <Button onClick={reset} variant="primary">
            Try Again
          </Button>
          
          <Button onClick={() => (window.location.href = '/')} variant="secondary">
            Go Home
          </Button>
        </div>
      </div>
    </div>
  );
}
