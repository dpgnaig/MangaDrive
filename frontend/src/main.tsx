import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ConfigProvider, theme } from 'antd'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      theme={{ algorithm: theme.darkAlgorithm, token: { colorPrimary: '#ff6b2c', borderRadius: 8 } }}
      spin={{ indicator: <span className="ms spin" style={{ fontSize: 28, color: 'var(--accent)' }}>progress_activity</span> }}
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ConfigProvider>
  </React.StrictMode>
)
