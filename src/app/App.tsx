import { StudioShell } from './StudioShell';
import { useStudioState } from './useStudioState';

export function App() {
  const studio = useStudioState();
  return <StudioShell {...studio} />;
}
