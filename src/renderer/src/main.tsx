import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, theme } from 'antd';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm, token: { borderRadius: 4 } }}>
      <App />
    </ConfigProvider>
  </React.StrictMode>,
);
