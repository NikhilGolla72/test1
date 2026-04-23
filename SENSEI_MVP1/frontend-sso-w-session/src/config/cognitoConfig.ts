/**
 * AWS Cognito Configuration — OAuth 2.0 settings for the Cognito User Pool.
 *
 * This file contains:
 *   - Cognito User Pool identifiers (region, pool ID, client ID/secret)
 *   - OAuth 2.0 configuration (scopes, redirect URIs, response type)
 *   - Helper functions to build Cognito Hosted UI URLs
 *
 * The redirect URIs are environment-aware: localhost for development,
 * Amplify staging URL for production.
 */

export const cognitoConfig = {
  region: 'us-east-1',
  userPoolId: 'us-east-1_dN95Gfiev',
  userPoolWebClientId: 'd39crquvfb260vrjvs46ghnhi',
  userPoolWebClientSecret: '2c0s0au6sgaui2eiio76oi52ukvmc8lojo37n2tim222mv5dqbn',
  
  // Cognito Hosted UI domain
  domain: 'us-east-1dn95gfiev.auth.us-east-1.amazoncognito.com',
  
  // OAuth 2.0 Configuration
  oauth: {
    domain: 'us-east-1dn95gfiev.auth.us-east-1.amazoncognito.com',
    scope: ['openid', 'email'], // Request OpenID Connect and email claims
    // Redirect URIs — auto-detect localhost vs production
    redirectSignIn: window.location.origin.includes('localhost')
      ? 'http://localhost:5173/callback'
      : 'https://test.d1x4en8xksc3vc.amplifyapp.com/callback',
    redirectSignOut: window.location.origin.includes('localhost')
      ? 'http://localhost:5173/login'
      : 'https://test.d1x4en8xksc3vc.amplifyapp.com/login',
    responseType: 'code', // Authorization Code Grant (not implicit)
  },
};

/**
 * Build the Cognito Hosted UI login URL.
 * This URL redirects the user to Cognito's login page where they authenticate
 * via the configured identity provider (e.g., Azure AD SSO).
 * After authentication, Cognito redirects back to redirectSignIn with an auth code.
 */
export const getLoginUrl = () => {
  const { oauth, userPoolWebClientId } = cognitoConfig;
  const redirectUri = encodeURIComponent(oauth.redirectSignIn);
  const scopes = encodeURIComponent(oauth.scope.join(' '));
  
  const loginUrl = `https://${oauth.domain}/oauth2/authorize?client_id=${userPoolWebClientId}&response_type=${oauth.responseType}&scope=${scopes}&redirect_uri=${redirectUri}`;
  
  console.log('[CognitoConfig] Login URL:', loginUrl);
  return loginUrl;
};

/**
 * Build the Cognito logout URL.
 * Redirects to Cognito's /logout endpoint to clear the Cognito session,
 * then redirects back to the app's login page.
 * Note: Currently not used — the app does a local-only logout to preserve SSO session.
 */
export const getLogoutUrl = () => {
  const { oauth, userPoolWebClientId } = cognitoConfig;
  const redirectUri = encodeURIComponent(oauth.redirectSignOut);
  return `https://${oauth.domain}/logout?client_id=${userPoolWebClientId}&logout_uri=${redirectUri}`;
};

/**
 * Get the Cognito token endpoint URL.
 * Used by authService.handleCallback() to exchange the authorization code for tokens,
 * and by authService.refreshToken() to refresh expired tokens.
 */
export const getTokenEndpoint = () => {
  const { oauth } = cognitoConfig;
  return `https://${oauth.domain}/oauth2/token`;
};
