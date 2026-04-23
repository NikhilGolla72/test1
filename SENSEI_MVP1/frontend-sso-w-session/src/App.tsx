/**
 * App.tsx — Root application component.
 *
 * Sets up React Router and renders the route tree. All session monitoring
 * happens in the AppRoutes inner component via the useSessionMonitor hook.
 *
 * Route structure:
 *   /login        → Login page (public)
 *   /callback     → OAuth callback handler (public, processes auth code)
 *   /home         → Home dashboard (protected, all roles)
 *   /unauthorized → 403 page for users not in the database
 *   /             → Redirects to /login
 *
 * Session UI:
 *   - SessionModal: Shown when session is invalidated (replaced/idle/logout)
 *   - Dead tab overlay: Shown when another tab claims the session (new_tab)
 */

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ProtectedRoute, SessionModal } from './components'
import { useSessionMonitor } from './hooks/useSessionMonitor'
import Login from './pages/Login'
import Home from './pages/Home'
import Unauthorized from './pages/Unauthorized'
import Callback from './pages/Callback'
import './App.css'

/**
 * AppRoutes — Inner component that uses hooks requiring Router context.
 *
 * Separated from App because useSessionMonitor uses useLocation(),
 * which requires being inside a <BrowserRouter>.
 */
function AppRoutes() {
  // Hook that manages session monitoring and provides UI state
  const { showSessionModal, isTabDead, sessionMessage, closeModal } = useSessionMonitor();

  // ── Dead Tab Overlay (WhatsApp-style) ──────────────────────────────────
  // If another tab in the same browser claimed the session via BroadcastChannel,
  // freeze this tab entirely. No routes render, no navigation, no re-initialization.
  if (isTabDead) {
    return (
      <div style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: '#f3f4f6',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 99999,
      }}>
        <div style={{
          backgroundColor: 'white',
          padding: '2.5rem',
          borderRadius: '12px',
          boxShadow: '0 4px 24px rgba(0, 0, 0, 0.12)',
          maxWidth: '420px',
          textAlign: 'center',
        }}>
          {/* Warning icon */}
          <div style={{
            width: '64px',
            height: '64px',
            margin: '0 auto 1.25rem',
            borderRadius: '50%',
            backgroundColor: '#FEF3C7',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, color: '#1F2937', marginBottom: '0.75rem' }}>
            Session Ended
          </h2>
          <p style={{ color: '#6B7280', marginBottom: '0.25rem', lineHeight: 1.5 }}>
            {sessionMessage}
          </p>
          <p style={{ color: '#9CA3AF', fontSize: '0.85rem' }}>
            You can close this tab.
          </p>
        </div>
      </div>
    );
  }

  // ── Normal Route Rendering ─────────────────────────────────────────────
  return (
    <>
      {/* Session invalidation modal (for replaced/idle/logout — NOT new_tab) */}
      <SessionModal 
        show={showSessionModal} 
        message={sessionMessage} 
        onClose={closeModal}
      />
      
      <Routes>
        {/* Public routes — accessible without authentication */}
        <Route path="/login" element={<Login />} />
        <Route path="/callback" element={<Callback />} />
        
        {/* Protected route — Home dashboard, accessible by all authenticated roles */}
        <Route 
          path="/home" 
          element={
            <ProtectedRoute allowedRoles={['admin', 'pricing', 'catalog', 'approver_data', 'bu_manager']}>
              <Home />
            </ProtectedRoute>
          } 
        />
        
        {/* Error page — shown when user exists in Cognito but not in the backend database */}
        <Route path="/unauthorized" element={<Unauthorized />} />
        
        {/* Default redirect — send unknown routes to login */}
        <Route path="/" element={<Navigate to="/login" replace />} />
      </Routes>
    </>
  );
}

/**
 * App — Root component that wraps everything in BrowserRouter.
 */
function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  )
}

export default App
