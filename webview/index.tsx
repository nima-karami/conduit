import './monaco-setup';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import './styles.css';
import { installPerfProbe } from './perf-probe';
import { SettingsProvider } from './settings';

// window.__conduitPerf — responsiveness probe for the stress lane (idle until started).
installPerfProbe();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');
const root = createRoot(rootEl);
root.render(
  <SettingsProvider>
    <App />
  </SettingsProvider>,
);
