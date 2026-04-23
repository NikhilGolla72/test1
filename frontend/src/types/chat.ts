export type ChatMode = "assistant" | "analyzer";

export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ChatMessage {
  id: string;
  requestId?: string;
  role: "system" | "user" | "assistant";
  text: string;
  timestamp: string;
  timeframeLabel?: string;
  pending?: boolean;
}

export interface OutboundChatPayload {
  action: "calculator" | "observability_evaluation" | "analyzer";
  requestId: string;
  sessionId: string;
  prompt: string;
  mode: ChatMode;
  lookbackHours?: number;
  conversation?: ConversationTurn[];
  idToken?: string;
  continuationToken?: string;
}

export interface InboundChatPayload {
  type: "assistant_response" | "assistant_response_chunk" | "assistant_response_end" | "status_update" | "system" | "error";
  requestId?: string;
  sessionId?: string;
  mode?: ChatMode;
  answer?: string;
  answerChunk?: string;
  chunkIndex?: number;
  chunkTotal?: number;
  message?: string;
  status?: string;
  timeframeLabel?: string;
  continuationToken?: string;
  pagination?: {
    page?: number;
    totalPages?: number;
    totalRows?: number;
  };
  data?: unknown;
}
