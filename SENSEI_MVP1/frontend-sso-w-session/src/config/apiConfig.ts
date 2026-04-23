/**
 * API Configuration — Centralized configuration for all backend API endpoints.
 *
 * This file defines:
 *   - Base URLs for the REST API Gateway
 *   - Session management timing parameters
 *   - All endpoint paths
 *   - Helper functions for building full URLs and auth headers
 */

export const API_CONFIG = {
  // ── Base URLs ────────────────────────────────────────────────────────────
  // REST API Gateway base URL for SSO endpoints (ssologin, ssologout, session-validate)
  ssoBaseUrl: 'https://qgnrk2fx2g.execute-api.us-east-1.amazonaws.com/test',
  
  // REST API Gateway base URL for file management endpoints (pricing-catalog)
  // Reserved for future module implementations
  fileBaseUrl: 'https://ist9zxx88l.execute-api.us-east-1.amazonaws.com/test',
  
  // ── Session Management Timing ────────────────────────────────────────────
  // These values must stay in sync with the backend's IDLE_TIMEOUT_MS
  sessionConfig: {
    idleTimeoutMinutes: 30,        // Auto-logout after 30 minutes of inactivity
    validationIntervalSeconds: 30, // Poll /session-validate every 30s (fallback when WS is down)
  },
  
  // ── Endpoint Paths ───────────────────────────────────────────────────────
  endpoints: {
    // SSO endpoints (use ssoBaseUrl) — all protected by Cognito Authorizer
    ssologin: '/ssologin',              // POST — Login and register session
    logout: '/ssologout',               // POST — Explicit logout
    sessionValidate: '/session-validate', // POST — Periodic session health check
    // File management endpoints (use fileBaseUrl) — reserved for future modules
    pricingCatalog: '/pricing-catelog',
    upload: '/pricing-catelog/upload',
    confirmUpload: '/pricing-catelog/upload/confirm-upload',
    fileVersions: '/pricing-catelog/upload/file-versions',
    generateDownload: '/pricing-catelog/upload/generate-download-url',
    generateUpload: '/pricing-catelog/upload/generate-upload-url',
    listFiles: '/pricing-catelog/upload/list-files',
  },
  
  // ── Request Settings ─────────────────────────────────────────────────────
  timeout: 30000, // Request timeout in milliseconds
  
  retry: {
    maxAttempts: 3,   // Max retry attempts for failed requests
    delayMs: 1000,    // Delay between retries in milliseconds
  },
} as const;

/**
 * Build the full endpoint URL by combining the appropriate base URL with the endpoint path.
 * SSO endpoints use ssoBaseUrl; file management endpoints use fileBaseUrl.
 */
export const getEndpointUrl = (endpoint: keyof typeof API_CONFIG.endpoints): string => {
  // SSO endpoints use ssoBaseUrl
  if (endpoint === 'ssologin' || endpoint === 'logout' || endpoint === 'sessionValidate') {
    return `${API_CONFIG.ssoBaseUrl}${API_CONFIG.endpoints[endpoint]}`;
  }
  // File management endpoints use fileBaseUrl
  return `${API_CONFIG.fileBaseUrl}${API_CONFIG.endpoints[endpoint]}`;
};

/**
 * Create a Bearer token Authorization header for backend API calls.
 * Used for all SSO endpoints (/ssologin, /ssologout, /session-validate)
 * where API Gateway's Cognito Authorizer validates the ID token.
 */
export const createBearerAuthHeader = (idToken: string) => {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${idToken}`,
  };
};

/**
 * Create user context headers for file management endpoints.
 * These endpoints don't use Cognito Authorizer — instead they rely on
 * custom headers to identify the user and their role.
 * Reserved for future module implementations.
 */
export const createUserContextHeader = (email: string, role: string) => {
  return {
    'Content-Type': 'application/json',
    'x-user-email': email,
    'x-user-role': role,
  };
};
