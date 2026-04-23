/**
 * WebSocket Disconnect Lambda — $disconnect route
 *
 * Cleans up when a WebSocket connection closes. This fires when:
 *   - The user closes the browser tab
 *   - The frontend explicitly closes the WebSocket (e.g., during logout or tab yield)
 *   - The connection times out or drops due to network issues
 *
 * Simply deletes the connection record from DynamoDB so the Login Lambda
 * won't try to send messages to a dead connection.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// Initialize DynamoDB Document Client
const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

// WebSocket connections table
const CONNECTIONS_TABLE = "test-us1-sensei-session-ws-connections";

export const handler = async (event) => {
  try {
    // connectionId identifies which WebSocket connection was closed
    const connectionId = event.requestContext.connectionId;
    console.log(`WS Disconnect: ${connectionId}`);

    // Remove the connection record from DynamoDB
    await ddb.send(
      new DeleteCommand({
        TableName: CONNECTIONS_TABLE,
        Key: { connectionId },
      })
    );

    return { statusCode: 200, body: "Disconnected" };
  } catch (err) {
    console.error("WS Disconnect Error:", err);
    return { statusCode: 500, body: "Failed to disconnect" };
  }
};
