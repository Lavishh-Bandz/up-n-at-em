import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';

// Standard Vite + React entry point. Mounts the app into #root.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
