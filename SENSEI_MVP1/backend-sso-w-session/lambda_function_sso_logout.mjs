/**
 * SSO Logout Lambda — POST /ssologout
 *
 * Handles explicit user logout. Called by the frontend when the user clicks "Sign Out".
 *
 * Flow:
 *   1. Extract email and jti from Cognito authorizer claims.
 *   2. Look up the user in DynamoDB.
 *   3. Verify the request's jti matches the active SESSION_JTI in DynamoDB.
 *      - If it doesn't match, the session was already replaced by another login → 401.
 *      - This prevents a stale browser from logging out a newer session.
 *   4. Clear the session: set SESSION_STATUS to LOGGED_OUT, remove SESSION_JTI,
 *      and record LAST_LOGOUT timestamp.
 *
 * Important: This Lambda does NOT send WebSocket notifications. The frontend
 * handles cross-tab logout propagation via localStorage events and BroadcastChannel.
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

export const handler = async (event) => {
  try {
    console.log("Logout Event:", JSON.stringify(event, null, 2));

    // ── Step 1: Extract email and jti from Cognito claims ────────────────
    const claims = event.requestContext?.authorizer?.claims;

    if (!claims) {
      return response(401, { message: "Unauthorized - No claims" });
    }

    // Extract email (same logic as login — handles federated SSO usernames)
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

    // ── Step 3: Verify this is still the active session ──────────────────
    // If the stored SESSION_JTI doesn't match the token's jti, it means
    // another browser already replaced this session. Don't allow the old
    // browser to log out the new session.
    if (user.SESSION_JTI !== tokenJti) {
      return response(401, {
        message: "Session replaced by another login",
      });
    }

    // ── Step 4: Clear the session in DynamoDB ────────────────────────────
    const now = new Date().toISOString();
    await ddb.send(
      new UpdateCommand({
        TableName: USER_TABLE,
        Key: { UID: user.UID },
        UpdateExpression:
          "SET LAST_LOGOUT = :now, SESSION_STATUS = :status REMOVE SESSION_JTI",
        ExpressionAttributeValues: {
          ":now": now,
          ":status": "LOGGED_OUT",
        },
      })
    );

    return response(200, {
      message: "Logout successful",
      email: normalizedEmail,
      sessionStatus: "LOGGED_OUT",
    });

  } catch (err) {
    console.error("Logout Error:", err);
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
