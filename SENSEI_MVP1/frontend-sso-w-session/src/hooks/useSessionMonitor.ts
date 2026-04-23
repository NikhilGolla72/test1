/**
 * useSessionMonitor — React hook that bridges the SessionManager to the UI.
 *
 * This hook:
 *   1. Initializes the SessionManager when the user is authenticated and on a protected page
 *   2. Provides reactive state for session invalidation UI (modal, dead tab overlay)
 *   3. Handles different invalidation reasons with appropriate UX:
 *      - 'new_tab'  → Permanent dead screen (WhatsApp-style, no redirect)
 *      - 'replaced' → Modal with 3-second countdown, then full logout
 *      - 'idle'     → Modal with 3-second countdown, then full logout
 *      - 'logout'   → Modal with 3-second countdown, then full logout
 *
 * Used in App.tsx's AppRoutes component, which wraps all routes.
 */

import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { sessionManager } from '../auth/sessionManager';
import { authService } from '../auth/authService';
import { tokenManager } from '../auth/tokenManager';
import { API_CONFIG, getEndpointUrl, createBearerAuthHeader } from '../config/apiConfig';
import type { SessionInvalidationReason, SessionManagerConfig } from '../auth/types';

// WebSocket API Gateway URL for real-time cross-browser session notifications
const WS_URL = 'wss://y2ufxhga9h.execute-api.us-east-1.amazonaws.com/test';

/**
 * Build the SessionManagerConfig that wires the SessionManager to this app's
 * token storage and API layer. This decouples the session engine from the
 * specific auth implementation.
 */
function buildSessionConfig(): SessionManagerConfig {
  return {
    wsUrl: WS_URL,
    idleTimeoutMinutes: API_CONFIG.sessionConfig.idleTimeoutMinutes,
    validationIntervalSeconds: API_CONFIG.sessionConfig.validationIntervalSeconds,
    sessionValidateUrl: getEndpointUrl('sessionValidate'),
    getAuthToken: () => tokenManager.getIdToken(),
    getUserEmail: () => tokenManager.getUserInfo()?.email ?? null,
    getSessionId: () => tokenManager.getSessionId(),
    createAuthHeaders: (token: string) => createBearerAuthHeader(token),
  };
}

export const useSessionMonitor = () => {
  const location = useLocation();
  // ── Reactive state exposed to the UI ──────────────────────────────────
  const [showSessionModal, setShowSessionModal] = useState(false);
  const [sessionInvalidationReason, setSessionInvalidationReason] = useState<SessionInvalidationReason | null>(null);
  // When true, the entire app is blocked with a permanent overlay (WhatsApp-style dead tab)
  const [isTabDead, setIsTabDead] = useState(false);

  // ── Refs for initialization guard and stable callback ────────────────
  const initializedRef = useRef(false);
  // Use a ref for the callback so the SessionManager always calls the latest version
  // (avoids stale closure issues with React state setters)
  const callbackRef = useRef<((reason: SessionInvalidationReason) => void) | null>(null);

  // Update the callback ref on every render so it always has fresh state setters
  callbackRef.current = (reason: SessionInvalidationReason) => {
    console.log('[useSessionMonitor] Session invalidated:', reason);
    setSessionInvalidationReason(reason);

    if (reason === 'new_tab') {
      // WhatsApp-style: freeze this tab permanently. No redirect, no navigation,
      // no logout call. The tab just becomes a dead screen with a message.
      // This prevents any re-initialization loop that could occur if we tried
      // to navigate or re-render routes.
      setIsTabDead(true);
      return;
    }

    // For all other reasons (replaced, idle, logout):
    // Show the session ended modal, then auto-logout after 3 seconds
    setShowSessionModal(true);
    setTimeout(() => {
      authService.logout();
    }, 3000);
  };

  // ── Initialize SessionManager on mount (once, for authenticated users) ──
  useEffect(() => {
    const isAuthenticated = tokenManager.isAuthenticated();

    // Don't initialize if already initialized or user isn't authenticated
    if (initializedRef.current || !isAuthenticated) {
      return;
    }

    // Don't initialize on login or callback pages (auth flow is still in progress)
    if (location.pathname === '/callback' || location.pathname === '/login') {
      return;
    }

    initializedRef.current = true;
    console.log('[useSessionMonitor] Initializing session monitoring');

    // Wrap the callback ref in a stable function for the SessionManager
    const handleSessionInvalidated = (reason: SessionInvalidationReason) => {
      if (callbackRef.current) {
        callbackRef.current(reason);
      }
    };

    // Start all session monitoring (BroadcastChannel, WebSocket, polling, idle tracking)
    sessionManager.initialize(handleSessionInvalidated, buildSessionConfig());

    // Cleanup on unmount
    return () => {
      console.log('[useSessionMonitor] Cleaning up session monitoring');
      sessionManager.cleanup();
      initializedRef.current = false;
    };
  }, [location.pathname]);

  /**
   * Map the invalidation reason to a user-friendly message for the modal/overlay.
   */
  const getSessionMessage = (): string => {
    switch (sessionInvalidationReason) {
      case 'replaced':
        return 'Your session has been replaced by another login. You will be logged out.';
      case 'idle':
        return 'Your session has expired due to inactivity. You will be logged out.';
      case 'logout':
        return 'You have been logged out from another tab.';
      case 'new_tab':
        return 'PHILIPS SENSEI is open in another tab. This tab is no longer active.';
      default:
        return 'Your session has ended. You will be logged out.';
    }
  };

  return {
    showSessionModal,  // true when the "Session Ended" modal should be visible
    isTabDead,         // true when this tab should show the permanent dead overlay
    sessionMessage: getSessionMessage(), // Human-readable message for the current reason
    closeModal: () => setShowSessionModal(false), // Close handler (modal auto-redirects anyway)
  };
};
