import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './theme.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

// Registered after load so a failing service worker cannot delay first paint.
if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  });
}
