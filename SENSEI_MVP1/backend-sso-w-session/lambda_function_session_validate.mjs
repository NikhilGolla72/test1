/**
 * Session Validate Lambda — POST /session-validate
 *
 * Periodic session health check endpoint. The frontend polls this every 30 seconds
 * as a fallback mechanism (primary real-time sync is via WebSocket). This ensures
 * session invalidation is detected even if the WebSocket connection drops.
 *
 * Flow:
 *   1. Extract email and jti from Cognito authorizer claims.
 *   2. Look up the user in DynamoDB.
 *   3. JTI check: If the stored SESSION_JTI doesn't match the request's jti,
 *      the session was replaced by another login → 401 with REPLACED status.
 *   4. Idle timeout check: If LAST_ACTIVITY is older than 30 minutes,
 *      the session is expired due to inactivity → mark as LOGGED_OUT in DynamoDB
 *      and return 401 with IDLE_TIMEOUT status.
 *   5. If valid: update LAST_ACTIVITY to current time (keeps the session alive)
 *      and return 200 with ACTIVE status.
 *
 * The LAST_ACTIVITY update on each successful validation acts as a heartbeat —
 * as long as the frontend keeps polling, the session stays alive. If the user
 * closes their browser without logging out, the session will eventually expire
 * after 30 minutes of no validation calls.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  QueryCommand,
  UpdateCommand,
  DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";

// Initialize DynamoDB Document Client
const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

// ── Table & Index Names ──────────────────────────────────────────────────────
const USER_TABLE = "test-sensei-user-management";
const EMAIL_INDEX = "EMAIL-index";

// Server-side idle timeout: 30 minutes in milliseconds.
// Must match the frontend's idleTimeoutMinutes config for consistent behavior.
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export const handler = async (event) => {
  try {
    console.log("Session Validate Event:", JSON.stringify(event, null, 2));

    // ── Step 1: Extract email and jti from Cognito claims ────────────────
    const claims = event.requestContext?.authorizer?.claims;

    if (!claims) {
      return response(401, { message: "Unauthorized - No claims" });
    }

    // Extract email (same federated SSO username handling as login/logout)
    let email = claims.email;

    if (!email && claims["cognito:username"]) {
      const rawUsername = claims["cognito:username"];
      email = rawUsername.includes("_")
        ? rawUsername.split("_")[1]
        : rawUsername;
    }

    if (!email) {
      return response(401, { message: "Email not found in token" });
    }

    const normalizedEmail = email.toLowerCase();
    const tokenJti = claims.jti;

    if (!tokenJti) {
      return response(401, { message: "Token JTI missing" });
    }

    // ── Step 2: Look up user in DynamoDB ─────────────────────────────────
    const result = await ddb.send(
      new QueryCommand({
        TableName: USER_TABLE,
        IndexName: EMAIL_INDEX,
        KeyConditionExpression: "EMAIL = :email",
        ExpressionAttributeValues: {
          ":email": normalizedEmail,
        },
      })
    );

    if (!result.Items || result.Items.length === 0) {
      return response(403, { message: "User not found" });
    }

    const user = result.Items[0];

    // ── Step 3: JTI check — was this session replaced? ───────────────────
    // Compare the token's jti against the active SESSION_JTI in DynamoDB.
    // If they don't match, another browser logged in and replaced this session.
    if (user.SESSION_JTI !== tokenJti) {
      return response(401, {
        valid: false,
        message: "Session replaced by another login",
        sessionStatus: "REPLACED",
      });
    }

    // ── Step 4: Server-side idle timeout enforcement ─────────────────────
    // Check if the time since LAST_ACTIVITY exceeds the idle timeout (30 min).
    // This is a server-side enforcement — the frontend also checks locally,
    // but this catches cases where the frontend was killed without logging out.
    if (user.LAST_ACTIVITY) {
      const lastActivity = new Date(user.LAST_ACTIVITY).getTime();
      const now = Date.now();
      if (now - lastActivity >= IDLE_TIMEOUT_MS) {
        console.log(`Session idle timeout: last activity was ${user.LAST_ACTIVITY}`);
        // Mark session as logged out in DynamoDB so subsequent checks also fail
        await ddb.send(
          new UpdateCommand({
            TableName: USER_TABLE,
            Key: { UID: user.UID },
            UpdateExpression:
              "SET SESSION_STATUS = :status REMOVE SESSION_JTI",
            ExpressionAttributeValues: {
              ":status": "LOGGED_OUT",
            },
          })
        );
        return response(401, {
          valid: false,
          message: "Session expired due to inactivity",
          sessionStatus: "IDLE_TIMEOUT",
        });
      }
    }

    // ── Step 5: Session is valid — update heartbeat ──────────────────────
    // Update LAST_ACTIVITY to current time. This acts as a heartbeat:
    // as long as the frontend keeps calling this endpoint, the session stays alive.
    const now = new Date().toISOString();
    await ddb.send(
      new UpdateCommand({
        TableName: USER_TABLE,
        Key: { UID: user.UID },
        UpdateExpression: "SET LAST_ACTIVITY = :now",
        ExpressionAttributeValues: {
          ":now": now,
        },
      })
    );

    return response(200, {
      valid: true,
      email: normalizedEmail,
      sessionStatus: user.SESSION_STATUS || "ACTIVE",
    });

  } catch (err) {
    console.error("Session Validate Error:", err);
    return response(500, {
      message: "Internal Server Error",
      error: err.message,
    });
  }
};

/**
 * Build a standard API Gateway response with CORS headers.
 */
const response = (status, body) => ({
  statusCode: status,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
  },
  body: JSON.stringify(body),
});
