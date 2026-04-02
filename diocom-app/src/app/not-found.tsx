import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import Button from '@/components/ui/Button';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-mesh text-white flex items-center justify-center p-8">
      <div className="max-w-md w-full glass p-8 text-center">
        <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4 border border-primary/20">
          <FileQuestion className="w-8 h-8 text-primary" />
        </div>
        
        <h2 className="text-2xl font-black uppercase italic tracking-tighter mb-2">
          404: Not Found
        </h2>
        
        <p className="text-sm text-gray-400 mb-6">
          This atom does not exist in the compression swarm.
        </p>
        
        <Link href="/">
          <Button variant="primary">Return to Swarm</Button>
        </Link>
      </div>
    </div>
  );
}
