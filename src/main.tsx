import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './styles/tokens.css';
import './styles/globals.css';
import './components/ui.css';
import './styles/layout.css';
import './features/player/player.css';
import './features/timeline/timeline.css';
import './app/app.css';
import './styles/reference-fidelity.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
