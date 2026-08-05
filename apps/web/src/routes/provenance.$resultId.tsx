import { createFileRoute } from '@tanstack/react-router';
import ProvenancePage from '../pages/ProvenancePage';

export const Route = createFileRoute('/provenance/$resultId')({
  component: ProvenancePage,
});
