/**
 * WebSocket Connect Lambda — $connect route
 *
 * Handles new WebSocket connections from the frontend. When a user authenticates
 * and lands on the home page, the frontend opens a WebSocket connection passing
 * the user's email as a query parameter (e.g., wss://...?email=user@example.com).
 *
 * This Lambda stores the connection in DynamoDB so the SSO Login Lambda can later
 * find all connections for a given email and push SESSION_REPLACED notifications.
 *
 * Important design decision:
 *   Old connections for the same email are NOT deleted here. They must stay alive
 *   so the Login Lambda can send SESSION_REPLACED notifications to them. Cleanup
 *   happens either:
 *   - When the Login Lambda encounters a 410 Gone error (stale connection)
 *   - When the $disconnect Lambda fires (browser closes the connection)
 *   - Via DynamoDB TTL (24-hour auto-expiry as a safety net)
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// Initialize DynamoDB Document Client
const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

// WebSocket connections table — tracks live connections per user
const CONNECTIONS_TABLE = "test-us1-sensei-session-ws-connections";

export const handler = async (event) => {
  try {
    // connectionId is assigned by API Gateway for each WebSocket connection
    const connectionId = event.requestContext.connectionId;
    // Email is passed as a query string parameter by the frontend
    const email = event.queryStringParameters?.email?.toLowerCase();

    if (!email) {
      return { statusCode: 400, body: "Missing email parameter" };
    }

    console.log(`WS Connect: ${connectionId} for ${email}`);

    // Store the connection in DynamoDB.
    // The TTL field ensures stale connections are automatically cleaned up
    // after 24 hours even if $disconnect never fires (e.g., network failure).
    await ddb.send(
      new PutCommand({
        TableName: CONNECTIONS_TABLE,
        Item: {
          connectionId,                                    // Primary key
          email,                                           // Used by Login Lambda to find connections per user
          connectedAt: new Date().toISOString(),           // For debugging/auditing
          ttl: Math.floor(Date.now() / 1000) + 86400,     // Auto-expire after 24 hours (DynamoDB TTL)
        },
      })
    );

    return { statusCode: 200, body: "Connected" };
  } catch (err) {
    console.error("WS Connect Error:", err);
    return { statusCode: 500, body: "Failed to connect" };
  }
};
