import './monaco-setup';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import './fonts';
import './styles.css';
import { initialSettings } from './bridge';
import { installPerfProbe } from './perf-probe';
import { SettingsProvider } from './settings';
import { loadBootFonts } from './terminal-fonts';
import { installUnclaimedDropGuard } from './unclaimed-drop-guard';

// window.__conduitPerf — responsiveness probe for the stress lane (idle until started).
installPerfProbe();
installUnclaimedDropGuard(window);

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');
const root = createRoot(rootEl);
// Terminals measure their cell at construction, so the selected faces load first; the load never
// rejects and gives up on a timer (webview/terminal-fonts.ts).
void loadBootFonts(initialSettings).then(() =>
  root.render(
    <SettingsProvider>
      <App />
    </SettingsProvider>,
  ),
);
