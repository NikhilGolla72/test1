# Backend — SSO with Session Management

This backend is a set of AWS Lambda functions that power SSO authentication and real-time session management for the PHILIPS SENSEI application. It enforces single-session-per-user across browsers using DynamoDB, API Gateway, and WebSockets.

---

## Architecture Overview

```
┌─────────────┐     HTTPS (REST)      ┌──────────────────────┐      ┌─────────────────────────────────┐
│   Frontend   │ ───────────────────►  │  API Gateway (REST)  │ ───► │  Lambda: SSO Login / Logout /   │
│  (React App) │                       │  + Cognito Authorizer│      │  Session Validate               │
│              │     WSS               ├──────────────────────┤      ├─────────────────────────────────┤
│              │ ───────────────────►  │  API Gateway (WS)    │ ───► │  Lambda: WS Connect/Disconnect  │
└─────────────┘                        └──────────────────────┘      └────────────┬────────────────────┘
                                                                                  │
                                                                                  ▼
                                                                     ┌────────────────────────┐
                                                                     │       DynamoDB          │
                                                                     │                        │
                                                                     │  • User Management     │
                                                                     │    (users, sessions)   │
                                                                     │                        │
                                                                     │  • WS Connections      │
                                                                     │    (connectionId,email)│
                                                                     └────────────────────────┘
```

---

## Lambda Functions

### 1. `lambda_function_sso_login.mjs` — POST `/ssologin`

The main login handler. Called by the frontend after the user completes the Cognito OAuth flow and receives tokens.

**How it works:**

1. Extracts the user's email from the Cognito authorizer claims attached to the request by API Gateway.
2. Queries the `test-sensei-user-management` DynamoDB table (via `EMAIL-index`) to check if the user exists. If not found, returns `403 User not authorized`.
3. Saves the session by writing the token's `jti` (JWT ID) as `SESSION_JTI` in the user's DynamoDB record, along with `SESSION_STATUS = ACTIVE` and `LAST_ACTIVITY` timestamp.
4. **Cross-browser session enforcement:** If the user had a previous `SESSION_JTI` that differs from the current one (meaning they logged in from a new browser), the function notifies all existing WebSocket connections for that email by sending a `SESSION_REPLACED` message. The old browser receives this and logs out instantly.
5. Returns the user's email, name, role, session ID, and session status to the frontend.

**Response:**
```json
{
  "email": "[email]",
  "name": "[name]",
  "role": "admin",
  "sessionId": "abc-123-jti",
  "sessionStatus": "ACTIVE",
  "sessionTimeout": 1234567890
}
```

**Key behavior:** Only one active session per user at any time. A new login automatically invalidates the previous session across browsers in real time.

---

### 2. `lambda_function_sso_logout.mjs` — POST `/ssologout`

Handles explicit user logout.

**How it works:**

1. Extracts email and `jti` from Cognito authorizer claims.
2. Looks up the user in DynamoDB.
3. Verifies the request's `jti` matches the active `SESSION_JTI` in DynamoDB. If it doesn't match (session was already replaced by another login), returns `401`.
4. Sets `SESSION_STATUS = LOGGED_OUT`, removes `SESSION_JTI`, and records `LAST_LOGOUT` timestamp.

**Response:**
```json
{
  "message": "Logout successful",
  "email": "[email]",
  "sessionStatus": "LOGGED_OUT"
}
```

---

### 3. `lambda_function_session_validate.mjs` — POST `/session-validate`

Periodic session health check. The frontend polls this endpoint every 30 seconds (as a fallback when WebSocket is disconnected) to verify the session is still valid.

**How it works:**

1. Extracts email and `jti` from Cognito authorizer claims.
2. Looks up the user in DynamoDB.
3. **JTI check:** If the stored `SESSION_JTI` doesn't match the request's `jti`, the session was replaced → returns `401` with `sessionStatus: "REPLACED"`.
4. **Idle timeout check:** If `LAST_ACTIVITY` is older than 30 minutes, the session is expired due to inactivity → marks the session as `LOGGED_OUT` in DynamoDB and returns `401` with `sessionStatus: "IDLE_TIMEOUT"`.
5. If valid, updates `LAST_ACTIVITY` to the current time (keeps the session alive) and returns `200`.

**Response (valid):**
```json
{
  "valid": true,
  "email": "[email]",
  "sessionStatus": "ACTIVE"
}
```

**Response (replaced):**
```json
{
  "valid": false,
  "message": "Session replaced by another login",
  "sessionStatus": "REPLACED"
}
```

**Response (idle timeout):**
```json
{
  "valid": false,
  "message": "Session expired due to inactivity",
  "sessionStatus": "IDLE_TIMEOUT"
}
```

---

### 4. `lambda_function_ws_connect.mjs` — WebSocket `$connect`

Handles new WebSocket connections from the frontend.

**How it works:**

1. Reads `connectionId` from the WebSocket event and `email` from the query string (`?email=user@example.com`).
2. Stores the connection in the `test-us1-sensei-session-ws-connections` DynamoDB table with a 24-hour TTL.
3. Does NOT delete old connections for the same email — they must stay alive so the login Lambda can send `SESSION_REPLACED` notifications to them before they disconnect.

---

### 5. `lambda_function_ws_disconnect.mjs` — WebSocket `$disconnect`

Cleans up when a WebSocket connection closes.

**How it works:**

1. Reads `connectionId` from the event.
2. Deletes the connection record from the `test-us1-sensei-session-ws-connections` table.

---

## DynamoDB Tables

### `test-sensei-user-management`

Stores user accounts and active session state.

| Field | Description |
|---|---|
| `UID` | Primary key |
| `EMAIL` | User email (has GSI: `EMAIL-index`) |
| `NAME` | Display name |
| `ROLE` | User role (`admin`, `pricing`, `catalog`, `approver_data`, `bu_manager`) |
| `SESSION_JTI` | The `jti` claim from the active Cognito ID token — acts as the session identifier |
| `SESSION_STATUS` | `ACTIVE` or `LOGGED_OUT` |
| `LAST_LOGIN` | ISO timestamp of last login |
| `LAST_LOGOUT` | ISO timestamp of last logout |
| `LAST_ACTIVITY` | ISO timestamp of last validated activity (used for server-side idle timeout) |

### `test-us1-sensei-session-ws-connections`

Tracks active WebSocket connections for real-time notifications.

| Field | Description |
|---|---|
| `connectionId` | Primary key — the API Gateway WebSocket connection ID |
| `email` | User email (has GSI: `email-index`) |
| `connectedAt` | ISO timestamp |
| `ttl` | DynamoDB TTL — auto-expires after 24 hours |

---

## Complete Authentication Flow

```
User clicks "Sign in with SSO"
        │
        ▼
┌─────────────────────────────┐
│ 1. Frontend redirects to    │
│    Cognito Hosted UI        │
│    (/oauth2/authorize)      │
└──────────────┬──────────────┘
               │  User authenticates via SSO IdP
               ▼
┌─────────────────────────────┐
│ 2. Cognito redirects back   │
│    to /callback with auth   │
│    code                     │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ 3. Frontend exchanges code  │
│    for Cognito tokens       │
│    (id_token, access_token) │
│    via /oauth2/token        │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ 4. Frontend calls           │
│    POST /ssologin           │
│    with Bearer id_token     │
└──────────────┬──────────────┘
               │  API Gateway validates token via Cognito Authorizer
               ▼
┌─────────────────────────────┐
│ 5. Login Lambda:            │
│    • Looks up user in DB    │
│    • Saves session (JTI)    │
│    • If previous session    │
│      existed → sends        │
│      SESSION_REPLACED via   │
│      WebSocket to old       │
│      browser                │
│    • Returns user info +    │
│      role + sessionId       │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ 6. Frontend stores tokens,  │
│    user info, sessionId     │
│    in localStorage          │
│                             │
│    Opens WebSocket to       │
│    wss://...?email=...      │
│    for real-time session    │
│    notifications            │
│                             │
│    Starts polling           │
│    /session-validate every  │
│    30s as fallback          │
└─────────────────────────────┘
```

---

## Session Invalidation Scenarios

| Scenario | What happens |
|---|---|
| **User logs in from a new browser** | Login Lambda detects different `SESSION_JTI`, sends `SESSION_REPLACED` via WebSocket to all old connections. Old browser logs out instantly. |
| **User is idle for 30+ minutes** | Frontend detects idle locally. On next `/session-validate` poll, backend also enforces it server-side and marks session as `LOGGED_OUT`. |
| **User clicks Sign Out** | Frontend calls `/ssologout`. Backend clears `SESSION_JTI` and sets status to `LOGGED_OUT`. |
| **User opens a second tab (same browser)** | Handled entirely on the frontend via `BroadcastChannel` — no backend involvement. The new tab claims the session, old tab shows "open in another tab" message. |
| **WebSocket disconnects** | Frontend falls back to polling `/session-validate` every 30 seconds until WebSocket reconnects (exponential backoff, max 15 attempts). |

---

## API Gateway Configuration

### REST API
- Base URL: `https://qgnrk2fx2g.execute-api.us-east-1.amazonaws.com/test`
- All endpoints use a Cognito User Pool Authorizer that validates the `id_token` and injects claims into `event.requestContext.authorizer.claims`.
- CORS is enabled with `Access-Control-Allow-Origin: *`.

| Method | Path | Lambda |
|---|---|---|
| POST | `/ssologin` | `lambda_function_sso_login` |
| POST | `/ssologout` | `lambda_function_sso_logout` |
| POST | `/session-validate` | `lambda_function_session_validate` |

### WebSocket API
- URL: `wss://y2ufxhga9h.execute-api.us-east-1.amazonaws.com/test`
- The login Lambda uses the HTTPS management endpoint (`https://y2ufxhga9h.execute-api.us-east-1.amazonaws.com/test`) to push messages to connected clients.

| Route | Lambda |
|---|---|
| `$connect` | `lambda_function_ws_connect` |
| `$disconnect` | `lambda_function_ws_disconnect` |

---

## Session Identity: The `jti` Claim

The system uses the `jti` (JWT ID) claim from the Cognito ID token as the session identifier. Every time a user authenticates through Cognito, a new `jti` is generated. This is stored as `SESSION_JTI` in DynamoDB and compared on every validation request. If a new login produces a different `jti`, the old session is considered replaced.

This approach avoids the need for a separate session token — the Cognito token itself carries the session identity.
