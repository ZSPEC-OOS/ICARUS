import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'

window.addEventListener('unhandledrejection', (event) => {
  console.error('[Bluswan] Unhandled promise rejection:', event.reason)
})

window.addEventListener('error', (event) => {
  console.error('[Bluswan] Uncaught error:', event.error ?? event.message)
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
)
