import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/cockpit.css';
import App from './App';
import { bootstrapRuntimeServiceWorker } from './services/teslaCompat';

void bootstrapRuntimeServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
