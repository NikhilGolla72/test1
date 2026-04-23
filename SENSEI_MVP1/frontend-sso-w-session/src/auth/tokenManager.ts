/**
 * Token Manager — Handles storage and retrieval of Cognito tokens and user info.
 *
 * All auth data is persisted in localStorage (not sessionStorage) so that:
 *   - Tokens survive page refreshes
 *   - The session persists across browser tabs (same origin)
 *   - Cross-tab communication via StorageEvent works correctly
 *
 * Stored keys:
 *   - cognito_tokens  → { idToken, accessToken, refreshToken, expiresAt }
 *   - user_info       → { email, role, name }
 *   - session_id      → The jti claim from the ID token (used as session identifier)
 *   - userEmail, userRole, userName → Legacy individual keys for backward compatibility
 */

/** Shape of the Cognito token bundle stored in localStorage */
interface CognitoTokens {
  idToken: string;       // Cognito ID token — used for backend API authorization
  accessToken: string;   // Cognito access token — used for Cognito user operations
  refreshToken: string;  // Cognito refresh token — used to get new tokens when expired
  expiresAt: number;     // Epoch milliseconds when the tokens expire
  sessionId?: string;    // JWT ID (jti) — unique per authentication, used as session identifier
}

// ── localStorage key constants ───────────────────────────────────────────────
const TOKEN_KEY = 'cognito_tokens';
const USER_INFO_KEY = 'user_info';
const SESSION_ID_KEY = 'session_id';

export const tokenManager = {
  /**
   * Save Cognito tokens to localStorage.
   * If a sessionId is included in the token bundle, it's also saved separately
   * for quick access by the SessionManager.
   */
  saveTokens: (tokens: CognitoTokens) => {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
    if (tokens.sessionId) {
      localStorage.setItem(SESSION_ID_KEY, tokens.sessionId);
    }
    console.log('[TokenManager] Tokens saved to localStorage');
  },

  /** Retrieve the full token bundle from localStorage, or null if not present */
  getTokens: (): CognitoTokens | null => {
    const tokensStr = localStorage.getItem(TOKEN_KEY);
    if (!tokensStr) return null;
    
    try {
      return JSON.parse(tokensStr);
    } catch (error) {
      console.error('Error parsing tokens:', error);
      return null;
    }
  },

  /** Get just the ID token (used for Bearer auth in backend API calls) */
  getIdToken: (): string | null => {
    const tokens = tokenManager.getTokens();
    return tokens?.idToken || null;
  },

  /** Get the access token (used for Cognito user pool operations) */
  getAccessToken: (): string | null => {
    const tokens = tokenManager.getTokens();
    return tokens?.accessToken || null;
  },

  /** Get the refresh token (used to obtain new tokens when current ones expire) */
  getRefreshToken: (): string | null => {
    const tokens = tokenManager.getTokens();
    return tokens?.refreshToken || null;
  },

  /** Get the session ID (jti) — used by SessionManager for cross-browser detection */
  getSessionId: (): string | null => {
    return localStorage.getItem(SESSION_ID_KEY);
  },

  /** Save session ID separately (called after /ssologin returns the sessionId) */
  saveSessionId: (sessionId: string) => {
    localStorage.setItem(SESSION_ID_KEY, sessionId);
    console.log('[TokenManager] Session ID saved:', sessionId);
  },

  /** Check if the stored tokens have expired by comparing expiresAt to current time */
  isTokenExpired: (): boolean => {
    const tokens = tokenManager.getTokens();
    if (!tokens) return true;
    
    const now = Date.now();
    const isExpired = now >= tokens.expiresAt;
    
    if (isExpired) {
      console.log('[TokenManager] Token is expired');
    }
    
    return isExpired;
  },

  /**
   * Clear ALL auth data from storage.
   * Called during logout, session replacement, and error recovery.
   * Removes both the structured keys and legacy individual keys.
   */
  clearTokens: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_INFO_KEY);
    localStorage.removeItem(SESSION_ID_KEY);
    localStorage.removeItem('userRole');
    localStorage.removeItem('userEmail');
    localStorage.removeItem('userName');
    localStorage.removeItem('userPermissions');
    sessionStorage.clear();
    console.log('[TokenManager] All tokens and session data cleared');
  },

  /**
   * Save user info received from the backend /ssologin response.
   * Stored both as a JSON object and as individual keys for backward compatibility.
   */
  saveUserInfo: (email: string, role: string, name?: string) => {
    const userInfo = { email, role, name };
    localStorage.setItem(USER_INFO_KEY, JSON.stringify(userInfo));
    localStorage.setItem('userEmail', email);
    localStorage.setItem('userRole', role);
    if (name) {
      localStorage.setItem('userName', name);
    }
    console.log('[TokenManager] User info saved:', { email, role, name });
  },

  /** Retrieve user info (email, role, name) from localStorage */
  getUserInfo: (): { email: string; role: string; name?: string } | null => {
    const userInfoStr = localStorage.getItem(USER_INFO_KEY);
    if (!userInfoStr) return null;
    
    try {
      return JSON.parse(userInfoStr);
    } catch (error) {
      console.error('Error parsing user info:', error);
      return null;
    }
  },

  /**
   * Check if the user is currently authenticated.
   * Returns true only if tokens exist AND are not expired.
   */
  isAuthenticated: (): boolean => {
    const tokens = tokenManager.getTokens();
    if (!tokens) {
      console.log('[TokenManager] No tokens found');
      return false;
    }
    
    const isExpired = tokenManager.isTokenExpired();
    const isAuth = !isExpired;
    
    console.log('[TokenManager] Authentication check:', {
      hasTokens: !!tokens,
      isExpired,
      isAuthenticated: isAuth
    });
    
    return isAuth;
  },
};
