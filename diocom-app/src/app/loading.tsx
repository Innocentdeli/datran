import Spinner from '@/components/ui/Spinner';

export default function Loading() {
  return (
    <div className="min-h-screen bg-mesh flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <Spinner size="xl" variant="primary" />
        <p className="text-sm text-gray-400 uppercase tracking-widest font-bold">
          Initializing Swarm...
        </p>
      </div>
    </div>
  );
}
