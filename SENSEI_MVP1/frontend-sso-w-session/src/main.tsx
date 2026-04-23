/**
 * Application entry point.
 *
 * Renders the App component inside React StrictMode.
 * StrictMode causes double-invocation of effects in development,
 * which is why Callback.tsx uses a hasProcessed ref guard.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
