/**
 * Callback Page — Handles the OAuth 2.0 redirect from Cognito.
 *
 * This page is the redirect target after the user authenticates via the Cognito
 * Hosted UI. It processes the authorization code in two steps:
 *
 *   Step 1: Exchange the auth code for Cognito tokens (id_token, access_token, refresh_token)
 *           via authService.handleCallback() → Cognito's /oauth2/token endpoint.
 *
 *   Step 2: Call the backend POST /ssologin with the ID token to:
 *           - Validate the user exists in the database
 *           - Get the user's role and name
 *           - Register the session (SESSION_JTI) in DynamoDB
 *           - Trigger SESSION_REPLACED WebSocket notifications if needed
 *
 * After both steps succeed, tokens and user info are saved to localStorage
 * and the user is redirected to /home.
 *
 * Error handling:
 *   - 401 from /ssologin → Invalid token, redirect to /login
 *   - 403 from /ssologin → User not in database, redirect to /unauthorized
 *   - Any other error → Clear tokens, redirect to /login
 *
 * Uses hasProcessed ref to prevent double execution in React StrictMode.
 */

import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { authService } from '../auth/authService';
import { tokenManager } from '../auth/tokenManager';
import { getEndpointUrl, createBearerAuthHeader } from '../config/apiConfig';

export default function Callback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const hasProcessed = useRef(false);

  useEffect(() => {
    const handleCallback = async () => {
      // Prevent double execution in React StrictMode
      if (hasProcessed.current) {
        console.log('[Callback] Already processed, skipping duplicate execution');
        return;
      }
      hasProcessed.current = true;
      try {
        console.log('=== CALLBACK FLOW STARTED ===');
        console.log('[Callback] Processing OAuth callback');
        
        // Check if user is already authenticated (tokens exist and are valid)
        if (tokenManager.isAuthenticated()) {
          console.log('[Callback] User already authenticated, redirecting to home');
          navigate('/home', { replace: true });
          return;
        }
        
        // Get authorization code from URL
        const code = searchParams.get('code');
        const error = searchParams.get('error');

        if (error) {
          console.error('[Callback] OAuth error:', error);
          navigate('/login', { replace: true });
          return;
        }

        if (!code) {
          console.error('[Callback] No authorization code found');
          navigate('/login', { replace: true });
          return;
        }

        console.log('[Callback] Step 1: Exchanging authorization code for Cognito tokens');
        // Exchange code for tokens from Cognito
        const result = await authService.handleCallback(code);
        
        if (!result) {
          console.error('[Callback] Token exchange failed');
          navigate('/login', { replace: true });
          return;
        }

        const { email } = result;
        console.log('[Callback] Step 1 Complete: Cognito tokens received for email:', email);

        // Get ID token for backend API call
        const idToken = tokenManager.getIdToken();
        if (!idToken) {
          console.error('[Callback] No ID token available');
          navigate('/login', { replace: true });
          return;
        }

        console.log('[Callback] Step 2: Calling backend /ssologin API');

        // Call backend /ssologin endpoint to validate user and get role
        const loginResponse = await fetch(getEndpointUrl('ssologin'), {
          method: 'POST',
          headers: createBearerAuthHeader(idToken),
          body: JSON.stringify({}),
        });

        console.log('[Callback] /ssologin response status:', loginResponse.status);

        if (loginResponse.status === 401) {
          console.error('[Callback] 401 Unauthorized - Invalid or expired token');
          tokenManager.clearTokens();
          navigate('/login', { replace: true });
          return;
        }

        if (loginResponse.status === 403) {
          console.error('[Callback] 403 User Not Authorized - User not found in database');
          tokenManager.clearTokens();
          navigate('/unauthorized', { replace: true });
          return;
        }

        if (!loginResponse.ok) {
          const errorText = await loginResponse.text();
          console.error('[Callback] /ssologin API failed:', errorText);
          tokenManager.clearTokens();
          navigate('/login', { replace: true });
          return;
        }

        const userData = await loginResponse.json();
        console.log('[Callback] Step 2 Complete: User data received from backend:', {
          email: userData.email,
          name: userData.name,
          role: userData.role,
          sessionId: userData.sessionId,
          sessionStatus: userData.sessionStatus
        });

        // Save user info with role from backend API
        tokenManager.saveUserInfo(userData.email, userData.role, userData.name);
        
        // Save session ID for session management
        if (userData.sessionId) {
          tokenManager.saveSessionId(userData.sessionId);
          console.log('[Callback] Session ID saved for session tracking');
        }

        console.log('=== CALLBACK FLOW COMPLETE ===');
        console.log('[Callback] User authenticated with Cognito');
        console.log('[Callback] Tokens and user info saved to localStorage');
        console.log('[Callback] Redirecting to home page');

        // Small delay to ensure localStorage is fully written before navigation
        await new Promise(resolve => setTimeout(resolve, 100));

        // Redirect to home
        navigate('/home', { replace: true });
      } catch (error) {
        console.error('=== CALLBACK ERROR ===');
        console.error('[Callback] Error type:', error instanceof Error ? error.constructor.name : typeof error);
        console.error('[Callback] Error message:', error instanceof Error ? error.message : String(error));
        console.error('[Callback] Full error:', error);
        tokenManager.clearTokens();
        navigate('/login', { replace: true });
      }
    };

    handleCallback();
  }, [searchParams, navigate]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      background: 'linear-gradient(135deg, #0052cc 0%, #003d99 100%)',
    }}>
      <div style={{
        backgroundColor: 'rgba(255, 255, 255, 0.95)',
        padding: '3rem',
        borderRadius: '12px',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.1)',
        textAlign: 'center',
        maxWidth: '400px',
        backdropFilter: 'blur(10px)',
      }}>
        <div style={{
          width: '50px',
          height: '50px',
          border: '4px solid #f3f3f3',
          borderTop: '4px solid #0052cc',
          borderRadius: '50%',
          animation: 'spin 1s linear infinite',
          margin: '0 auto 1.5rem',
        }} />
        <h2 style={{ color: '#0052cc', marginBottom: '0.5rem', fontWeight: 'bold' }}>Authenticating...</h2>
        <p style={{ color: '#666' }}>Please wait while we complete your sign-in</p>
      </div>

      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
