import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { buttonClasses } from '@/components/ui/Button';

export default function NotFound() {
  return (
    <main className="bg-mesh flex min-h-dvh items-center justify-center p-4 sm:p-8">
      <div className="panel w-full max-w-md p-8 text-center">
        <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-primary/25 bg-primary/10 text-primary" aria-hidden="true">
          <FileQuestion className="h-7 w-7" />
        </span>
        <p className="text-sm font-medium text-primary">404</p>
        <h1 className="mb-2 mt-1 text-xl font-semibold text-white">Page not found</h1>
        <p className="mb-6 text-sm text-gray-300">
          The page you&apos;re looking for doesn&apos;t exist or has moved. If you followed a share link, it may have expired.
        </p>
        <Link href="/" className={buttonClasses('primary', 'md')}>Back to Datran</Link>
      </div>
    </main>
  );
}
