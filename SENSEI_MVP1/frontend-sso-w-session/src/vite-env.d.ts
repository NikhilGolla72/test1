/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Cognito
  readonly VITE_COGNITO_REGION: string;
  readonly VITE_COGNITO_USER_POOL_ID: string;
  readonly VITE_COGNITO_CLIENT_ID: string;
  readonly VITE_COGNITO_CLIENT_SECRET: string;
  readonly VITE_COGNITO_DOMAIN: string;
  readonly VITE_COGNITO_REDIRECT_SIGN_IN: string;
  readonly VITE_COGNITO_REDIRECT_SIGN_OUT: string;
  readonly VITE_COGNITO_SCOPES: string;

  // API
  readonly VITE_SSO_BASE_URL: string;
  readonly VITE_FILE_BASE_URL: string;

  // Session
  readonly VITE_WS_URL: string;
  readonly VITE_IDLE_TIMEOUT_MINUTES: string;
  readonly VITE_SESSION_VALIDATION_INTERVAL_SECONDS: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
