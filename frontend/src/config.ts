export const appConfig = {
  region: import.meta.env.VITE_AWS_REGION,
  // userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
  // userPoolClientId: import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID,
  websocketApiUrl: import.meta.env.VITE_WEBSOCKET_API_URL,
  defaultAnalysisLookbackHours: Number(
    import.meta.env.VITE_DEFAULT_ANALYSIS_LOOKBACK_HOURS ?? 720,
  ),
};

export function validateConfig(): void {
  const required = [
    ["VITE_AWS_REGION", appConfig.region],
    // ["VITE_COGNITO_USER_POOL_ID", appConfig.userPoolId],
    // ["VITE_COGNITO_USER_POOL_CLIENT_ID", appConfig.userPoolClientId],
    ["VITE_WEBSOCKET_API_URL", appConfig.websocketApiUrl],
  ];

  const missing = required.filter(([, value]) => !value).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Missing frontend environment variables: ${missing.join(", ")}`);
  }
}
