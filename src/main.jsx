import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'


if (window.location.pathname === '/') {
  window.location.replace('/landing.html')
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
)
