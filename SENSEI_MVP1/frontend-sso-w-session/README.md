# Frontend — SSO with Session Management

A React + TypeScript + Vite application that implements Cognito SSO authentication with real-time session management. The app enforces single-session-per-user across browsers and single-tab-per-session within the same browser.

---

## Tech Stack

- React 18 + TypeScript
- Vite (build tool + dev server)
- React Router v6 (client-side routing)
- AWS Cognito (OAuth 2.0 Authorization Code Grant)
- WebSocket (real-time cross-browser session sync)
- BroadcastChannel API (same-browser tab enforcement)
- AWS Amplify (hosting)

---

## Project Structure

```
src/
├── auth/                    # Authentication & session management core
│   ├── authService.ts       # Cognito OAuth flow (login, callback, logout, refresh)
│   ├── tokenManager.ts      # localStorage CRUD for tokens and user info
│   ├── sessionManager.ts    # Session enforcement engine (WS, polling, idle, tabs)
│   ├── types.ts             # Shared TypeScript types for session management
│   └── index.ts             # Barrel export
│
├── config/                  # Configuration
│   ├── apiConfig.ts         # Backend API URLs, endpoints, and header helpers
│   └── cognitoConfig.ts     # Cognito User Pool settings and OAuth URLs
│
├── components/              # Shared UI components
│   ├── TopNavbar.tsx        # Navigation bar with logo, links, and sign-out dropdown
│   ├── ProtectedRoute.tsx   # Route guard (auth check + role-based access)
│   ├── SessionModal.tsx     # Full-screen modal for session invalidation
│   ├── Footer.tsx           # Philips copyright footer
│   └── index.tsx            # Barrel export + inline UI primitives (Card, Button, etc.)
│
├── hooks/                   # React hooks
│   ├── useSessionMonitor.ts # Bridges SessionManager to React UI state
│   └── index.ts             # Barrel export
│
├── pages/                   # Route pages
│   ├── Login.tsx            # SSO login page with "Sign in with SSO" button
│   ├── Callback.tsx         # OAuth callback — exchanges code for tokens, calls /ssologin
│   ├── Home.tsx             # Dashboard with module cards (display only)
│   └── Unauthorized.tsx     # 403 page for users not in the backend database
│
├── styles/                  # CSS files for each page/component
│   ├── Home.css
│   ├── Login.css
│   ├── TopNavbar.css
│   ├── Unauthorized.css
│   └── PageLayout.css
│
├── App.tsx                  # Root component — routes + session UI (modal, dead tab)
├── main.tsx                 # Entry point — renders App in StrictMode
└── index.css                # Global styles
```

---

## Authentication Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                        AUTHENTICATION FLOW                          │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. User visits /login                                               │
│     └─ Login.tsx checks if already authenticated                     │
│        ├─ Yes → redirect to /home                                    │
│        └─ No  → show "Sign in with SSO" button                      │
│                                                                      │
│  2. User clicks "Sign in with SSO"                                   │
│     └─ authService.login() redirects to Cognito Hosted UI            │
│        └─ Cognito handles SSO (e.g., Azure AD federation)            │
│                                                                      │
│  3. Cognito redirects to /callback?code=AUTH_CODE                    │
│     └─ Callback.tsx processes the code in two steps:                 │
│                                                                      │
│        Step 1: Exchange code for Cognito tokens                      │
│        ├─ POST to Cognito /oauth2/token                              │
│        ├─ Uses Basic Auth (client_id:client_secret)                  │
│        ├─ Receives: id_token, access_token, refresh_token            │
│        └─ Tokens saved to localStorage via tokenManager              │
│                                                                      │
│        Step 2: Register session with backend                         │
│        ├─ POST /ssologin with Bearer id_token                        │
│        ├─ Backend validates user exists in database                   │
│        ├─ Backend saves SESSION_JTI, returns user role/name           │
│        ├─ If previous session existed → sends SESSION_REPLACED via WS │
│        └─ Frontend saves user info + sessionId to localStorage       │
│                                                                      │
│  4. Redirect to /home                                                │
│     └─ ProtectedRoute checks auth + role → renders Home              │
│     └─ useSessionMonitor initializes SessionManager                  │
│        ├─ Opens WebSocket for cross-browser sync                     │
│        ├─ Claims tab via BroadcastChannel                            │
│        ├─ Starts idle monitoring                                     │
│        └─ Starts polling /session-validate as fallback               │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Session Management

The session system has four independent enforcement layers:

### 1. Same-Browser Tab Enforcement (BroadcastChannel)

Only one tab per browser can be active at a time. When a new tab opens and the SessionManager initializes, it broadcasts a `TAB_CLAIM` message on the `session_tab_channel` BroadcastChannel. Any existing tabs receive this message and immediately yield — they show a permanent "open in another tab" overlay (WhatsApp-style) without redirecting or logging out.

This uses BroadcastChannel instead of localStorage to avoid race conditions that can occur when multiple tabs write to localStorage simultaneously.

### 2. Cross-Browser Session Enforcement (WebSocket)

When the user logs in from a different browser, the backend Login Lambda detects a different `SESSION_JTI` and sends a `SESSION_REPLACED` message via WebSocket to all connections for that email. The old browser receives this message and:
- Checks if its local sessionId matches the `newSessionJti` in the message
- If it doesn't match (old session), shows the session ended modal and logs out after 3 seconds
- If it matches (this IS the new session), ignores the message

### 3. Idle Timeout (Client + Server)

Two layers of idle detection:
- Client-side: The SessionManager tracks user activity (mouse, keyboard, click, scroll) and writes the timestamp to `localStorage.last_activity`. Every 60 seconds, it checks if the idle time exceeds 30 minutes.
- Server-side: The `/session-validate` endpoint checks `LAST_ACTIVITY` in DynamoDB. If it's older than 30 minutes, the session is marked as `LOGGED_OUT`.

Both use the same 30-minute threshold for consistency.

### 4. Polling Fallback (/session-validate)

If the WebSocket connection drops, the SessionManager falls back to polling the backend `/session-validate` endpoint every 30 seconds. When the WebSocket is connected, polling is skipped (WebSocket handles it instantly). The polling detects:
- Session replacement (different `SESSION_JTI` in DynamoDB)
- Idle timeout (server-side enforcement)
- Explicit logout from another browser

---

## Session Invalidation UI

| Reason | UI Behavior |
|---|---|
| `new_tab` | Permanent dead overlay — "PHILIPS SENSEI is open in another tab." No redirect. |
| `replaced` | SessionModal with 3-second countdown → full logout → redirect to /login |
| `idle` | SessionModal with 3-second countdown → full logout → redirect to /login |
| `logout` | SessionModal with 3-second countdown → full logout → redirect to /login |

---

## Data Storage (localStorage)

| Key | Value | Purpose |
|---|---|---|
| `cognito_tokens` | `{ idToken, accessToken, refreshToken, expiresAt }` | Cognito token bundle |
| `user_info` | `{ email, role, name }` | User profile from backend |
| `session_id` | `string` (jti) | Session identifier for cross-browser detection |
| `last_activity` | `number` (epoch ms) | Last user interaction timestamp for idle detection |
| `session_invalidated` | `{ reason, timestamp, sessionId }` | Cross-tab invalidation event propagation |

---

## Role-Based Access

The app supports five roles, each with different module visibility:

| Role | Visible Modules |
|---|---|
| `admin` | All 6 modules (full access to everything) |
| `pricing` | Service Pricing (full), Service Catalog (view), Terms, SOW |
| `catalog` | Service Catalog (full), Service Pricing (view), Terms, SOW |
| `approver_data` | Approval Matrix (full), BU Threshold (view), Pricing (view), Catalog (view), Terms, SOW |
| `bu_manager` | BU Threshold (full), Pricing (view), Catalog (view), Terms, SOW |

Module cards on the Home page are currently display-only (non-clickable).

---

## Environment Configuration

### `.env` file (frontend-sso-w-session/.env)

```env
VITE_COGNITO_REGION=us-east-1
VITE_COGNITO_USER_POOL_ID=us-east-1_xxxxx
VITE_COGNITO_CLIENT_ID=xxxxx
VITE_COGNITO_CLIENT_SECRET=xxxxx
VITE_COGNITO_DOMAIN=xxxxx.auth.us-east-1.amazoncognito.com
VITE_COGNITO_REDIRECT_SIGN_IN=http://localhost:5173/callback
VITE_COGNITO_REDIRECT_SIGN_OUT=http://localhost:5173/login
VITE_COGNITO_SCOPES=openid email
VITE_SSO_BASE_URL=https://xxxxx.execute-api.us-east-1.amazonaws.com/test
VITE_FILE_BASE_URL=https://xxxxx.execute-api.us-east-1.amazonaws.com/test
VITE_WS_URL=wss://xxxxx.execute-api.us-east-1.amazonaws.com/test
VITE_IDLE_TIMEOUT_MINUTES=30
VITE_SESSION_VALIDATION_INTERVAL_SECONDS=30
```

---

## Development

```bash
# Install dependencies
npm install

# Start dev server (http://localhost:5173)
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

---

## Deployment

The app is deployed to AWS Amplify at:
- Staging: `https://test.d1x4en8xksc3vc.amplifyapp.com`

The Cognito redirect URIs are configured to support both `localhost:5173` (development) and the Amplify URL (production). The detection is automatic based on `window.location.origin`.
