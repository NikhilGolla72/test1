# Bugfix Requirements Document

## Introduction

The Catalogue Pricing application implements a single-tab session enforcement feature: when a user opens a new tab of the same website and logs in, the previous tab should be logged out. This feature is currently broken — the new tab either logs itself out immediately after login, or the old tab is not reliably notified of the session replacement. The root cause involves the WebSocket notification mechanism sending `SESSION_REPLACED` messages to all connections for a user (including the newly opened tab), and insufficient differentiation between old and new sessions at the connection level.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a user opens a new tab and completes the login flow THEN the system sends a `SESSION_REPLACED` WebSocket message to ALL connections for that email, including the new tab's own WebSocket connection that was pre-connected before `/ssologin` was called, causing the new tab to immediately invalidate its own session and log itself out.

1.2 WHEN a user opens a new tab and completes the login flow THEN the backend WebSocket connect Lambda (`lambda_function_ws_connect.mjs`) stores only `connectionId` and `email` without any session identifier, so there is no way to distinguish old-session connections from new-session connections when broadcasting `SESSION_REPLACED`.

1.3 WHEN the SSO login Lambda (`lambda_function_sso_login.mjs`) calls `notifySessionReplaced` THEN it queries all WebSocket connections by email and sends `SESSION_REPLACED` to every connection indiscriminately, including the connection that belongs to the tab that just initiated the new login.

1.4 WHEN the new tab's `sessionManager` receives the `SESSION_REPLACED` WebSocket message THEN it calls `invalidateSession('replaced')` without checking whether the message pertains to its own session or a previous session, resulting in the new tab logging itself out.

### Expected Behavior (Correct)

2.1 WHEN a user opens a new tab and completes the login flow THEN the system SHALL only send the `SESSION_REPLACED` WebSocket message to connections associated with the previous session, and the new tab SHALL remain logged in with an active session.

2.2 WHEN a WebSocket connection is established THEN the backend SHALL store a session identifier (e.g., the JWT `jti`) alongside the `connectionId` and `email`, so connections can be associated with specific sessions.

2.3 WHEN the SSO login Lambda calls `notifySessionReplaced` THEN it SHALL only notify WebSocket connections whose stored session identifier matches the previous session's `jti`, excluding connections associated with the new session's `jti`.

2.4 WHEN the frontend `sessionManager` receives a `SESSION_REPLACED` WebSocket message THEN it SHALL compare the message's session information against its own current session ID and only invalidate the session if the message targets a different (older) session, not its own.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a user logs in from a completely different browser or device THEN the system SHALL CONTINUE TO detect the session replacement and log out the previous browser's session via WebSocket notification.

3.2 WHEN a user's session is idle beyond the configured timeout (30 minutes) THEN the system SHALL CONTINUE TO invalidate the session due to inactivity.

3.3 WHEN a user explicitly clicks logout THEN the system SHALL CONTINUE TO broadcast the logout event to other tabs via localStorage and clean up the session on the backend.

3.4 WHEN the WebSocket connection drops and reconnects THEN the system SHALL CONTINUE TO fall back to polling-based session validation via the `/session-validate` endpoint.

3.5 WHEN a user logs in from a different browser and the old browser's WebSocket is disconnected THEN the polling fallback SHALL CONTINUE TO detect the session replacement by comparing `SESSION_JTI` on the backend.

3.6 WHEN multiple tabs are open in the same browser and one tab logs out THEN the system SHALL CONTINUE TO propagate the logout to other tabs via the `session_invalidated` localStorage event.
