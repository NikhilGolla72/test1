/**
 * Shared types for session management.
 *
 * These types define the contract between the SessionManager, the useSessionMonitor
 * hook, and the App component. Import these when plugging the session system into
 * another application.
 */

/**
 * Reasons a session can be invalidated:
 * - 'replaced'  — Another browser logged in and replaced this session (detected via WebSocket or polling)
 * - 'idle'      — User was inactive for longer than the idle timeout (30 min)
 * - 'logout'    — User explicitly clicked Sign Out (propagated to other tabs via localStorage)
 * - 'manual'    — Programmatic invalidation (reserved for future use)
 * - 'new_tab'   — Another tab in the SAME browser claimed the session via BroadcastChannel
 */
export type SessionInvalidationReason = 'replaced' | 'idle' | 'logout' | 'manual' | 'new_tab';

/**
 * Event object written to localStorage to propagate session invalidation across tabs.
 * Other tabs listen for StorageEvent changes on the 'session_invalidated' key.
 */
export interface SessionInvalidationEvent {
  reason: SessionInvalidationReason;
  timestamp: number;
  sessionId?: string;
}

/**
 * Configuration object that wires the SessionManager to the host application's
 * token storage, API endpoints, and auth headers. This decouples the session
 * management logic from any specific token/auth implementation.
 */
export interface SessionManagerConfig {
  /** WebSocket URL for real-time cross-browser session notifications (wss://...) */
  wsUrl: string;
  /** Idle timeout in minutes before auto-logout (must match backend's IDLE_TIMEOUT_MS) */
  idleTimeoutMinutes: number;
  /** How often (in seconds) to poll /session-validate as a fallback when WebSocket is down */
  validationIntervalSeconds: number;
  /** Full URL of the backend /session-validate endpoint */
  sessionValidateUrl: string;
  /** Function to retrieve the current Cognito ID token for backend API calls */
  getAuthToken: () => string | null;
  /** Function to retrieve the current user's email for WebSocket connection */
  getUserEmail: () => string | null;
  /** Function to retrieve the current session ID (jti) for cross-tab/cross-browser detection */
  getSessionId: () => string | null;
  /** Function to create authorization headers (Bearer token) for backend API calls */
  createAuthHeaders: (token: string) => Record<string, string>;
}
