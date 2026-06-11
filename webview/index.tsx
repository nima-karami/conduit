import './monacoSetup';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { post } from './bridge';
import { SettingsProvider } from './settings';

// Beacon so the host can confirm the webview JS is running and messaging works,
// independent of the terminal.
post({ type: 'ready' });

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');
const root = createRoot(rootEl);
root.render(
  <SettingsProvider>
    <App />
  </SettingsProvider>,
);
