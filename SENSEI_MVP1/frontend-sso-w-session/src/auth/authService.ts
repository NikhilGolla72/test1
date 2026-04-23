/**
 * Auth Service — Handles the Cognito OAuth 2.0 authentication flow.
 *
 * Responsibilities:
 *   - Redirect to Cognito Hosted UI for SSO login
 *   - Exchange authorization code for tokens (Authorization Code Grant)
 *   - Refresh expired tokens using the refresh token
 *   - Call backend /ssologout on explicit logout
 *   - Provide authentication state checks
 *
 * Token flow:
 *   1. User clicks "Sign in with SSO" → redirected to Cognito Hosted UI
 *   2. After SSO authentication, Cognito redirects to /callback with an auth code
 *   3. handleCallback() exchanges the code for id_token, access_token, refresh_token
 *   4. Tokens are saved via tokenManager, then Callback.tsx calls /ssologin
 */

import { cognitoConfig, getLoginUrl, getTokenEndpoint } from '../config/cognitoConfig';
import { tokenManager } from './tokenManager';
import { getEndpointUrl, createBearerAuthHeader } from '../config/apiConfig';

/**
 * Decode a JWT token's payload without verification.
 * Used to extract claims (email, jti, exp) from the ID token client-side.
 * Note: Actual token verification is done server-side by API Gateway's Cognito Authorizer.
 */
const decodeJWT = (token: string): any => {
  try {
    // JWT structure: header.payload.signature — we only need the payload (index 1)
    const base64Url = token.split('.')[1];
    // Convert base64url to standard base64
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    // Decode and parse the JSON payload
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(jsonPayload);
  } catch (error) {
    console.error('Error decoding JWT:', error);
    return null;
  }
};

export const authService = {
  /**
   * Initiate SSO login by redirecting to the Cognito Hosted UI.
   * Cognito handles the SSO flow (e.g., Azure AD federation) and redirects
   * back to the app's /callback route with an authorization code.
   */
  login: () => {
    const loginUrl = getLoginUrl();
    console.log('[AuthService] Redirecting to Cognito login');
    window.location.href = loginUrl;
  },

  /**
   * Handle the OAuth callback — exchange the authorization code for Cognito tokens.
   *
   * Uses the Authorization Code Grant with PKCE-less flow (client_secret is used instead).
   * The code is exchanged at Cognito's /oauth2/token endpoint using Basic Auth
   * (client_id:client_secret).
   *
   * @param code - The authorization code from the Cognito redirect URL
   * @returns Object with email and idToken, or null on failure
   */
  handleCallback: async (code: string): Promise<{ email: string; idToken: string } | null> => {
    try {
      console.log('[AuthService] Exchanging authorization code for tokens');
      
      const tokenEndpoint = getTokenEndpoint();
      const { userPoolWebClientId, userPoolWebClientSecret, oauth } = cognitoConfig;

      // Create Basic Auth header: base64(client_id:client_secret)
      const credentials = btoa(`${userPoolWebClientId}:${userPoolWebClientSecret}`);

      // Build the token exchange request body
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: userPoolWebClientId,
        code: code,
        redirect_uri: oauth.redirectSignIn, // Must match the redirect URI registered in Cognito
      });

      const response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${credentials}`,
        },
        body: body.toString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[AuthService] Token exchange failed:', errorText);
        throw new Error(`Token exchange failed: ${response.status}`);
      }

      const data = await response.json();
      console.log('[AuthService] Tokens received successfully');

      // Decode the ID token to extract user claims (email, identities, etc.)
      const idTokenPayload = decodeJWT(data.id_token);
      if (!idTokenPayload) {
        throw new Error('Failed to decode ID token');
      }

      // Extract email: try direct email claim first, then cognito:username
      let email = idTokenPayload.email || idTokenPayload['cognito:username'];
      
      // For federated SSO users, the email may be in the identities array
      // (e.g., when using Azure AD as an identity provider)
      if (idTokenPayload.identities && Array.isArray(idTokenPayload.identities) && idTokenPayload.identities.length > 0) {
        const primaryIdentity = idTokenPayload.identities.find((id: any) => id.primary === 'true') || idTokenPayload.identities[0];
        if (primaryIdentity && primaryIdentity.userId) {
          email = primaryIdentity.userId;
        }
      }
      
      console.log('[AuthService] User email:', email);

      // Calculate token expiration time (Cognito returns expires_in in seconds)
      const expiresIn = data.expires_in || 3600; // Default 1 hour
      const expiresAt = Date.now() + expiresIn * 1000;

      // Persist tokens in localStorage via tokenManager
      tokenManager.saveTokens({
        idToken: data.id_token,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt,
      });

      return { email, idToken: data.id_token };
    } catch (error) {
      console.error('[AuthService] Error in handleCallback:', error);
      return null;
    }
  },

  /**
   * Logout the user.
   *
   * Flow:
   *   1. Call backend /ssologout to clear the session in DynamoDB
   *      (if the session was already replaced, backend returns 401 — that's fine)
   *   2. Clear all tokens and user info from localStorage
   *   3. Redirect to /login
   *
   * Note: This does NOT redirect to Cognito's /logout endpoint. The Cognito
   * session may still be active, so the next "Sign in with SSO" click will
   * auto-authenticate without prompting for credentials (SSO behavior).
   */
  logout: async () => {
    console.log('=== LOGOUT FLOW STARTED ===');
    console.log('[AuthService] Logging out user');
    
    const idToken = tokenManager.getIdToken();
    
    // Call backend /ssologout to clear the server-side session
    if (idToken) {
      try {
        console.log('[AuthService] Calling backend /ssologout API');
        
        const response = await fetch(getEndpointUrl('logout'), {
          method: 'POST',
          headers: createBearerAuthHeader(idToken),
          body: JSON.stringify({}),
        });

        console.log('[AuthService] /ssologout response status:', response.status);

        if (response.status === 401) {
          // 401 means the session was already replaced — that's expected in some flows
          console.log('[AuthService] Session was already replaced by another login');
          const errorData = await response.json();
          console.log('[AuthService] Backend message:', errorData.message);
        } else if (response.ok) {
          const data = await response.json();
          console.log('[AuthService] Logout successful:', data.message);
        } else {
          const errorText = await response.text();
          console.error('[AuthService] Logout API failed:', errorText);
        }
      } catch (error) {
        // Network errors shouldn't block the local logout
        console.error('[AuthService] Error calling logout API:', error);
      }
    } else {
      console.log('[AuthService] No ID token found, skipping backend API call');
    }
    
    // Clear all local auth data regardless of backend response
    tokenManager.clearTokens();
    
    console.log('=== LOGOUT FLOW COMPLETE ===');
    console.log('[AuthService] Redirecting to login page');
    
    // Hard redirect to /login (not React navigation — ensures full state reset)
    window.location.href = '/login';
  },

  /**
   * Refresh the access/ID tokens using the stored refresh token.
   * Called when the current tokens are about to expire.
   *
   * @returns true if refresh succeeded, false otherwise
   */
  refreshToken: async (): Promise<boolean> => {
    try {
      const refreshToken = tokenManager.getRefreshToken();
      if (!refreshToken) {
        console.log('[AuthService] No refresh token available');
        return false;
      }

      console.log('[AuthService] Refreshing access token');
      
      const tokenEndpoint = getTokenEndpoint();
      const { userPoolWebClientId, userPoolWebClientSecret } = cognitoConfig;

      const credentials = btoa(`${userPoolWebClientId}:${userPoolWebClientSecret}`);

      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: userPoolWebClientId,
        refresh_token: refreshToken,
      });

      const response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${credentials}`,
        },
        body: body.toString(),
      });

      if (!response.ok) {
        console.error('[AuthService] Token refresh failed');
        return false;
      }

      const data = await response.json();
      console.log('[AuthService] Token refreshed successfully');

      const expiresIn = data.expires_in || 3600;
      const expiresAt = Date.now() + expiresIn * 1000;

      // Update tokens but keep the existing refresh token
      // (Cognito doesn't always return a new refresh token on refresh)
      const currentTokens = tokenManager.getTokens();
      tokenManager.saveTokens({
        idToken: data.id_token,
        accessToken: data.access_token,
        refreshToken: currentTokens?.refreshToken || refreshToken,
        expiresAt,
      });

      return true;
    } catch (error) {
      console.error('[AuthService] Error refreshing token:', error);
      return false;
    }
  },

  /** Check if the user is currently authenticated (tokens exist and not expired) */
  isAuthenticated: (): boolean => {
    return tokenManager.isAuthenticated();
  },

  /** Get the current user's email from stored user info */
  getUserEmail: (): string | null => {
    const userInfo = tokenManager.getUserInfo();
    return userInfo?.email || null;
  },

  /** Get the current user's role from stored user info */
  getUserRole: (): string | null => {
    const userInfo = tokenManager.getUserInfo();
    return userInfo?.role || 'user';
  },
};
