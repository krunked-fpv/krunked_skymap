import { useSkyStore } from './store/useSkyStore';

export default function App() {
  const observer = useSkyStore((s) => s.observer);
  return (
    <main style={{ padding: 24, fontFamily: 'monospace', color: '#E2E8F0' }}>
      <h1>Krunked Sky-Map Initializing...</h1>
      <p>{observer.label}</p>
    </main>
  );
}
