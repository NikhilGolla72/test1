/**
 * SSO Login Lambda — POST /ssologin
 *
 * This is the main login handler called by the frontend after the user completes
 * the Cognito OAuth flow and receives tokens. API Gateway's Cognito Authorizer
 * validates the ID token and injects the decoded claims into the event.
 *
 * Flow:
 *   1. Extract user email from Cognito authorizer claims.
 *   2. Look up the user in the DynamoDB user management table.
 *      - If not found → 403 (user not authorized / not in the system).
 *   3. Save the new session by writing the token's `jti` (JWT ID) as SESSION_JTI,
 *      setting SESSION_STATUS to ACTIVE, and updating LAST_ACTIVITY.
 *   4. If a previous SESSION_JTI existed and differs from the current one,
 *      it means the user logged in from a new browser. In that case, send a
 *      SESSION_REPLACED WebSocket message to all existing connections for this
 *      email so the old browser logs out instantly.
 *   5. Return user info (email, name, role, sessionId, sessionStatus) to the frontend.
 *
 * Key design decision:
 *   Only one active session per user at any time. A new login automatically
 *   invalidates the previous session across browsers in real time via WebSocket.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";

// Initialize DynamoDB Document Client (simplifies working with JS objects vs raw AttributeValues)
const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

// ── Table & Index Names ──────────────────────────────────────────────────────
// User management table — stores user accounts, roles, and active session state
const USER_TABLE = "test-sensei-user-management";
// GSI on EMAIL field for looking up users by email
const EMAIL_INDEX = "EMAIL-index";
// WebSocket connections table — tracks live WS connections per user
const CONNECTIONS_TABLE = "test-us1-sensei-session-ws-connections";
// GSI on email field for finding all WS connections belonging to a user
const CONNECTIONS_EMAIL_INDEX = "email-index";

// ── WebSocket API Endpoint ───────────────────────────────────────────────────
// HTTPS endpoint used by ApiGatewayManagementApiClient to push messages
// to connected WebSocket clients. This is the HTTPS version of the WSS URL.
const WS_ENDPOINT = "https://y2ufxhga9h.execute-api.us-east-1.amazonaws.com/test" ;

export const handler = async (event) => {
  try {
    console.log("Incoming Event:", JSON.stringify(event, null, 2));

    // ── Step 1: Extract email from Cognito authorizer claims ─────────────
    // API Gateway's Cognito Authorizer decodes the ID token and places
    // the claims at event.requestContext.authorizer.claims
    const claims = event.requestContext?.authorizer?.claims;

    if (!claims) {
      return response(401, { message: "Unauthorized - No claims" });
    }

    // Try to get email directly from claims; fall back to cognito:username
    // (for federated SSO users, the username format is "provider_email")
    let email = claims.email;

    if (!email && claims["cognito:username"]) {
      const rawUsername = claims["cognito:username"];
      // For federated users, extract email after the provider prefix (e.g., "AzureAD_user@example.com")
      email = rawUsername.includes("_")
        ? rawUsername.split("_")[1]
        : rawUsername;
    }

    if (!email) {
      return response(401, { message: "Email not found in token" });
    }

    // Normalize email to lowercase for consistent lookups
    const normalizedEmail = email.toLowerCase();

    // The jti (JWT ID) claim is a unique identifier for this specific token.
    // We use it as the session identifier — each new authentication produces a new jti.
    const tokenJti = claims.jti;
    const tokenExp = claims.exp;

    if (!tokenJti) {
      return response(401, { message: "Token JTI missing" });
    }

    // ── Step 2: Look up user in DynamoDB ─────────────────────────────────
    // Query the user management table by email using the GSI
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

    // If user doesn't exist in the database, they're not authorized to use the system
    if (!result.Items || result.Items.length === 0) {
      return response(403, { message: "User not authorized" });
    }

    const user = result.Items[0];
    // Save the previous session's JTI before overwriting — needed to detect session replacement
    const previousJti = user.SESSION_JTI;
    const now = new Date().toISOString();

    // ── Step 3: Save new session in DynamoDB ─────────────────────────────
    // Overwrite SESSION_JTI with the new token's jti, mark session as ACTIVE,
    // and set LAST_ACTIVITY (used for server-side idle timeout enforcement)
    await ddb.send(
      new UpdateCommand({
        TableName: USER_TABLE,
        Key: { UID: user.UID },
        UpdateExpression:
          "SET LAST_LOGIN = :now, SESSION_JTI = :jti, SESSION_STATUS = :status, LAST_ACTIVITY = :now",
        ExpressionAttributeValues: {
          ":now": now,
          ":jti": tokenJti,
          ":status": "ACTIVE",
        },
      })
    );

    // ── Step 4: Notify old browser if session was replaced ───────────────
    // If there was a previous session AND it's different from the current one,
    // the user logged in from a new browser. Notify all WebSocket connections
    // for this email so the old browser can log out instantly.
    console.log(`Session check: previousJti=${previousJti}, currentJti=${tokenJti}, WS_ENDPOINT=${WS_ENDPOINT}`);
    if (previousJti && previousJti !== tokenJti && WS_ENDPOINT) {
      console.log(`Session replaced! Notifying WebSocket connections for ${normalizedEmail}`);
      await notifySessionReplaced(normalizedEmail, tokenJti);
    } else {
      console.log(`No session replacement needed (first login or same session)`);
    }

    // ── Step 5: Return user data to frontend ─────────────────────────────
    return response(200, {
      email: user.EMAIL,
      name: user.NAME,
      role: user.ROLE,
      sessionId: tokenJti,        // Frontend stores this to compare against SESSION_REPLACED messages
      sessionStatus: "ACTIVE",
      sessionTimeout: tokenExp,   // Token expiration time (epoch seconds)
    });

  } catch (err) {
    console.error("Login Error:", err);
    return response(500, {
      message: "Internal Server Error",
      error: err.message,
    });
  }
};

/**
 * Notify all WebSocket connections for a given email that their session was replaced.
 *
 * Sends a SESSION_REPLACED message to every connection. The new browser's tab will
 * ignore it (because its local session JTI matches newJti), while old browser tabs
 * will detect the mismatch and log out.
 *
 * After notifying, stale connections (410 Gone) are cleaned up from DynamoDB.
 *
 * @param {string} email - The user's email address
 * @param {string} newJti - The JTI of the new session (so the new browser can ignore the message)
 */
async function notifySessionReplaced(email, newJti) {
  try {
    if (!WS_ENDPOINT) {
      console.log("No WS_ENDPOINT configured, skipping WebSocket notification");
      return;
    }

    // Find all WebSocket connections for this email using the GSI
    const connectionsResult = await ddb.send(
      new QueryCommand({
        TableName: CONNECTIONS_TABLE,
        IndexName: CONNECTIONS_EMAIL_INDEX,
        KeyConditionExpression: "email = :email",
        ExpressionAttributeValues: {
          ":email": email,
        },
      })
    );

    if (!connectionsResult.Items || connectionsResult.Items.length === 0) {
      console.log("No active WebSocket connections for:", email);
      return;
    }

    // Create the API Gateway Management API client to push messages to WebSocket connections
    const wsClient = new ApiGatewayManagementApiClient({
      endpoint: WS_ENDPOINT,
    });

    // Build the SESSION_REPLACED payload
    const message = JSON.stringify({
      type: "SESSION_REPLACED",
      message: "Your session has been replaced by a new login",
      newSessionJti: newJti,  // Included so the new browser can identify itself and ignore
      timestamp: new Date().toISOString(),
    });

    // PostToConnectionCommand requires binary data
    const encoder = new TextEncoder();
    const messageData = encoder.encode(message);

    // Send to ALL connections in parallel. The new browser ignores it; old browsers log out.
    const sendPromises = connectionsResult.Items.map(async (conn) => {
      try {
        await wsClient.send(
          new PostToConnectionCommand({
            ConnectionId: conn.connectionId,
            Data: messageData,
          })
        );
        console.log(`Notified connection ${conn.connectionId}`);
      } catch (err) {
        // 410 Gone means the connection is stale (client disconnected but DynamoDB wasn't cleaned up)
        if (err.statusCode === 410 || err.$metadata?.httpStatusCode === 410) {
          console.log(`Removing stale connection: ${conn.connectionId}`);
          await ddb.send(
            new DeleteCommand({
              TableName: CONNECTIONS_TABLE,
              Key: { connectionId: conn.connectionId },
            })
          ).catch(() => {}); // Best-effort cleanup
        } else {
          console.error(`Error notifying ${conn.connectionId}:`, err);
        }
      }
    });

    await Promise.all(sendPromises);
    console.log(`Notified ${connectionsResult.Items.length} connections for ${email}`);

  } catch (err) {
    // Don't fail the login if WebSocket notification fails — login should still succeed
    console.error("Error sending WebSocket notifications:", err);
  }
}

/**
 * Build a standard API Gateway response with CORS headers.
 * @param {number} status - HTTP status code
 * @param {object} body - Response body (will be JSON-stringified)
 */
const response = (status, body) => ({
  statusCode: status,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
  },
  body: JSON.stringify(body),
});
