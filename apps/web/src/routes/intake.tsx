import { createFileRoute } from '@tanstack/react-router';
import IntakePage from '../pages/IntakePage';

function Skeleton() {
  return (
    <div className="animate-pulse space-y-6">
      <div className="h-8 bg-gray-200 rounded w-64" />
      <div className="bg-gray-100 rounded-xl h-44" />
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-gray-100 rounded-xl h-72" />
        <div className="bg-gray-100 rounded-xl h-72" />
      </div>
    </div>
  );
}

export const Route = createFileRoute('/intake')({
  component: IntakePage,
  pendingComponent: Skeleton,
});
