import './monacoSetup';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { post } from './bridge';

// Beacon so the host can confirm the webview JS is running and messaging works,
// independent of the terminal.
post({ type: 'ready' });

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
