/**
 * Session Manager — Core session enforcement engine.
 *
 * Handles four independent concerns:
 *
 * 1. SAME-BROWSER TAB ENFORCEMENT (BroadcastChannel)
 *    Only one tab per browser can be active. When a new tab opens, it broadcasts
 *    a TAB_CLAIM message. Existing tabs receive it and yield (WhatsApp-style).
 *    Uses BroadcastChannel instead of localStorage to avoid race conditions.
 *
 * 2. CROSS-BROWSER SESSION ENFORCEMENT (WebSocket)
 *    When a user logs in from a different browser, the Login Lambda sends a
 *    SESSION_REPLACED message via WebSocket to all connections for that email.
 *    The old browser receives it and logs out instantly.
 *
 * 3. IDLE TIMEOUT (Client-side + Server-side)
 *    Client-side: Checks localStorage's last_activity timestamp every 60 seconds.
 *    Server-side: The /session-validate endpoint also enforces idle timeout.
 *    Both use the same 30-minute threshold for consistency.
 *
 * 4. POLLING FALLBACK (/session-validate)
 *    If the WebSocket disconnects, the manager falls back to polling the backend
 *    every 30 seconds to check if the session is still valid. When WebSocket is
 *    connected, polling is skipped (WebSocket handles it instantly).
 *
 * Lifecycle:
 *   initialize() → starts all monitoring → cleanup() tears everything down
 *
 * The manager is a singleton exported as `sessionManager`.
 */

import type { SessionInvalidationReason, SessionInvalidationEvent, SessionManagerConfig } from './types';

// ── localStorage keys ────────────────────────────────────────────────────────
const LAST_ACTIVITY_KEY = 'last_activity';           // Epoch ms of last user interaction
const SESSION_INVALIDATED_KEY = 'session_invalidated'; // JSON event for cross-tab propagation
const TAB_CHANNEL_NAME = 'session_tab_channel';        // BroadcastChannel name for same-browser tab sync

/** Message format for BroadcastChannel tab coordination */
interface TabMessage {
  type: 'TAB_CLAIM' | 'TAB_YIELD';
  tabId: string;
}

class SessionManager {
  // ── Internal state ───────────────────────────────────────────────────────
  private config: SessionManagerConfig | null = null;          // Injected config (URLs, token getters, etc.)
  private idleCheckInterval: number | null = null;             // setInterval ID for idle timeout checks
  private validationInterval: number | null = null;            // setInterval ID for backend polling
  private storageListener: ((e: StorageEvent) => void) | null = null; // Cross-tab localStorage listener
  private activityListeners: (() => void)[] = [];              // DOM event handlers for activity tracking
  private onSessionInvalidated: ((reason: SessionInvalidationReason) => void) | null = null; // Callback to notify React
  private currentTabId: string | null = null;                  // Unique ID for this tab (for BroadcastChannel)
  private ws: WebSocket | null = null;                         // WebSocket connection for cross-browser sync
  private wsReconnectTimeout: number | null = null;            // setTimeout ID for WS reconnection
  private wsReconnectAttempts = 0;                             // Counter for exponential backoff
  private isCleaningUp = false;                                // Guard to prevent actions during cleanup
  private isSessionInvalidated = false;                        // Guard to prevent double invalidation
  private tabChannel: BroadcastChannel | null = null;          // BroadcastChannel for same-browser tab sync

  // Initialize session monitoring
  initialize(
    onSessionInvalidated: (reason: SessionInvalidationReason) => void,
    config: SessionManagerConfig,
  ) {
    console.log('[SessionManager] Initializing session monitoring');
    this.onSessionInvalidated = onSessionInvalidated;
    this.config = config;
    this.isCleaningUp = false;
    this.isSessionInvalidated = false;
    this.wsReconnectAttempts = 0;

    // Generate unique tab ID and claim active session via BroadcastChannel
    this.currentTabId = `tab_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    this.setupTabChannel();

    // Update last activity timestamp
    this.updateLastActivity();

    // Start idle timeout monitoring
    this.startIdleMonitoring();

    // Connect WebSocket for instant cross-browser session invalidation
    this.connectWebSocket();

    // Start periodic session validation as fallback (in case WS disconnects)
    this.startSessionValidation();

    // Listen for cross-tab session_invalidated events (logout/replaced propagation)
    this.startCrossTabListener();

    // Track user activity for idle detection
    this.startActivityTracking();
  }

  // Clean up all listeners and intervals
  cleanup() {
    console.log('[SessionManager] Cleaning up session monitoring');
    this.isCleaningUp = true;

    this.closeTabChannel();
    this.disconnectWebSocket();

    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }

    if (this.validationInterval) {
      clearInterval(this.validationInterval);
      this.validationInterval = null;
    }

    if (this.storageListener) {
      window.removeEventListener('storage', this.storageListener);
      this.storageListener = null;
    }

    this.activityListeners.forEach(listener => {
      window.removeEventListener('mousemove', listener);
      window.removeEventListener('keydown', listener);
      window.removeEventListener('click', listener);
      window.removeEventListener('scroll', listener);
    });
    this.activityListeners = [];

    this.onSessionInvalidated = null;
    this.config = null;
    this.currentTabId = null;
  }

  // ==================== Same-Browser Tab Enforcement (BroadcastChannel) ====================

  private setupTabChannel() {
    try {
      this.tabChannel = new BroadcastChannel(TAB_CHANNEL_NAME);

      this.tabChannel.onmessage = (event: MessageEvent<TabMessage>) => {
        if (this.isSessionInvalidated || this.isCleaningUp) return;

        const msg = event.data;

        if (msg.type === 'TAB_CLAIM' && msg.tabId !== this.currentTabId) {
          // Another tab is claiming the session — we must yield
          console.log('[SessionManager] New tab claimed session, this tab must yield:', msg.tabId);
          this.isSessionInvalidated = true;
          this.disconnectWebSocket();
          this.closeTabChannel();
          if (this.onSessionInvalidated) {
            this.onSessionInvalidated('new_tab');
          }
        }
      };

      // Broadcast that THIS tab is now the active one.
      // Any other tabs listening will receive TAB_CLAIM and yield.
      console.log('[SessionManager] Broadcasting TAB_CLAIM:', this.currentTabId);
      this.tabChannel.postMessage({ type: 'TAB_CLAIM', tabId: this.currentTabId } as TabMessage);
    } catch (err) {
      console.error('[SessionManager] BroadcastChannel not supported, falling back to single-tab only:', err);
    }
  }

  private closeTabChannel() {
    if (this.tabChannel) {
      try { this.tabChannel.close(); } catch (_) { /* ignore */ }
      this.tabChannel = null;
    }
  }

  // ==================== WebSocket (Instant Cross-Browser Sync) ====================

  private connectWebSocket() {
    if (this.isCleaningUp || this.isSessionInvalidated || !this.config) return;

    const email = this.config.getUserEmail();
    if (!email) {
      console.log('[SessionManager] No user email, skipping WebSocket connection');
      return;
    }

    // Close any existing connection first
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      try { this.ws.close(); } catch (_) { /* ignore */ }
      this.ws = null;
    }

    try {
      const fullUrl = `${this.config.wsUrl}?email=${encodeURIComponent(email)}`;
      console.log('[SessionManager] Connecting WebSocket for cross-browser sync...');

      this.ws = new WebSocket(fullUrl);

      this.ws.onopen = () => {
        console.log('[SessionManager] WebSocket connected - cross-browser sync active');
        this.wsReconnectAttempts = 0;
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('[SessionManager] WebSocket message received:', data.type);

          if (data.type === 'SESSION_REPLACED') {
            // If this tab's session JTI matches the new one, this IS the new session — ignore.
            const localSessionId = this.config?.getSessionId() ?? null;
            if (localSessionId && data.newSessionJti === localSessionId) {
              console.log('[SessionManager] SESSION_REPLACED received but we are the new session, ignoring');
              return;
            }
            console.log('[SessionManager] Session replaced in another browser - instant logout');
            this.invalidateSession('replaced');
          }
        } catch (err) {
          console.error('[SessionManager] Error parsing WebSocket message:', err);
        }
      };

      this.ws.onclose = () => {
        this.ws = null;
        if (!this.isCleaningUp && !this.isSessionInvalidated) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        // onclose fires after onerror, reconnection handled there
      };
    } catch (err) {
      console.error('[SessionManager] Failed to create WebSocket:', err);
    }
  }

  private disconnectWebSocket() {
    if (this.wsReconnectTimeout) {
      clearTimeout(this.wsReconnectTimeout);
      this.wsReconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      try { this.ws.close(); } catch (_) { /* ignore */ }
      this.ws = null;
    }
  }

  private scheduleReconnect() {
    if (this.isCleaningUp || this.isSessionInvalidated) return;
    if (this.wsReconnectAttempts >= 15) {
      console.log('[SessionManager] Max WebSocket reconnect attempts reached, relying on polling');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.wsReconnectAttempts), 30000);
    this.wsReconnectAttempts++;

    console.log(`[SessionManager] WebSocket reconnecting in ${delay}ms (attempt ${this.wsReconnectAttempts})`);

    this.wsReconnectTimeout = window.setTimeout(() => {
      if (!this.isCleaningUp && !this.isSessionInvalidated) {
        this.connectWebSocket();
      }
    }, delay);
  }

  // ==================== Idle Monitoring ====================

  private updateLastActivity() {
    localStorage.setItem(LAST_ACTIVITY_KEY, Date.now().toString());
  }

  private getLastActivity(): number {
    const lastActivity = localStorage.getItem(LAST_ACTIVITY_KEY);
    return lastActivity ? parseInt(lastActivity, 10) : Date.now();
  }

  private isSessionIdle(): boolean {
    if (!this.config) return false;
    const idleTimeMs = this.config.idleTimeoutMinutes * 60 * 1000;
    return (Date.now() - this.getLastActivity()) >= idleTimeMs;
  }

  private startIdleMonitoring() {
    this.idleCheckInterval = window.setInterval(() => {
      if (this.isSessionIdle()) {
        console.log('[SessionManager] Session idle timeout detected');
        this.invalidateSession('idle');
      }
    }, 60 * 1000);
  }

  // ==================== Backend Validation (Polling Fallback) ====================

  private startSessionValidation() {
    if (!this.config) return;
    const intervalMs = this.config.validationIntervalSeconds * 1000;

    // First check after 5s
    setTimeout(() => {
      if (!this.isCleaningUp && !this.isSessionInvalidated) {
        this.validateSessionWithBackend();
      }
    }, 5000);

    this.validationInterval = window.setInterval(async () => {
      // Skip polling if WebSocket is connected (WS handles it instantly)
      if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
      await this.validateSessionWithBackend();
    }, intervalMs);
  }

  private async validateSessionWithBackend() {
    if (this.isSessionInvalidated || !this.config) return;
    try {
      const idToken = this.config.getAuthToken();
      if (!idToken) return;

      const response = await fetch(this.config.sessionValidateUrl, {
        method: 'POST',
        headers: this.config.createAuthHeaders(idToken),
        body: JSON.stringify({}),
      });

      if (response.status === 401) {
        const data = await response.json();
        console.log('[SessionManager] Backend says session invalid:', data.message);
        if (data.sessionStatus === 'IDLE_TIMEOUT') {
          this.invalidateSession('idle');
        } else {
          this.invalidateSession('replaced');
        }
        return;
      }

      if (response.ok) {
        const data = await response.json();
        if (data.sessionStatus === 'LOGGED_OUT') {
          console.log('[SessionManager] Session logged out from another browser');
          this.invalidateSession('replaced');
        }
      }
    } catch (error) {
      console.error('[SessionManager] Error validating session:', error);
    }
  }

  // ==================== Cross-Tab Listener (logout/replaced propagation) ====================

  private startCrossTabListener() {
    this.storageListener = (e: StorageEvent) => {
      // Only listen for session_invalidated events (logout or replaced from another tab)
      if (e.key === SESSION_INVALIDATED_KEY && e.newValue) {
        try {
          const event: SessionInvalidationEvent = JSON.parse(e.newValue);
          console.log('[SessionManager] Session invalidation from another tab:', event.reason);
          if (event.reason === 'logout' || event.reason === 'replaced') {
            this.invalidateSession(event.reason);
          }
        } catch (error) {
          console.error('[SessionManager] Error parsing invalidation event:', error);
        }
      }
    };

    window.addEventListener('storage', this.storageListener);
  }

  // ==================== Activity Tracking ====================

  private startActivityTracking() {
    let throttleTimeout: number | null = null;
    const throttledHandler = () => {
      if (!throttleTimeout) {
        throttleTimeout = window.setTimeout(() => {
          this.updateLastActivity();
          throttleTimeout = null;
        }, 5000);
      }
    };

    this.activityListeners.push(throttledHandler);
    window.addEventListener('mousemove', throttledHandler);
    window.addEventListener('keydown', throttledHandler);
    window.addEventListener('click', throttledHandler);
    window.addEventListener('scroll', throttledHandler);
  }

  // ==================== Session Invalidation ====================

  private invalidateSession(reason: SessionInvalidationReason) {
    if (this.isSessionInvalidated) return; // Prevent double invalidation
    this.isSessionInvalidated = true;

    console.log('[SessionManager] Invalidating session, reason:', reason);

    // Disconnect WebSocket immediately
    this.disconnectWebSocket();
    this.closeTabChannel();

    const event: SessionInvalidationEvent = {
      reason,
      timestamp: Date.now(),
      sessionId: this.config?.getSessionId() || undefined,
    };
    localStorage.setItem(SESSION_INVALIDATED_KEY, JSON.stringify(event));

    if (this.onSessionInvalidated) {
      this.onSessionInvalidated(reason);
    }
  }

  logout() {
    this.invalidateSession('logout');
  }
}

export const sessionManager = new SessionManager();
