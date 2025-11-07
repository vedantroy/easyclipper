import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { QueryParamProvider } from 'use-query-params'
import { WindowHistoryAdapter } from 'use-query-params/adapters/window'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryParamProvider adapter={WindowHistoryAdapter}>
      <App />
    </QueryParamProvider>
  </StrictMode>,
)
