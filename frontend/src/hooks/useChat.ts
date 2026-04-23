import { useEffect, useMemo, useRef, useState } from "react";
import { appConfig } from "../config";
import { getIdToken } from "../services/auth";
import { ChatWebSocketClient } from "../services/websocketClient";
import type { ChatMessage, ChatMode, ConversationTurn, InboundChatPayload } from "../types/chat";

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function asIsoTime(): string {
  return new Date().toISOString();
}

function isListingResponse(text: string): boolean {
  return /Page\s+\d+\s+of\s+\d+\s+-\s+(Session IDs|Trace IDs)/i.test(text);
}

function toPlainText(text: string): string {
  const noFence = text.replace(/```[\s\S]*?```/g, (block) =>
    block
      .replace(/```(?:json|markdown|text)?\n?/gi, "")
      .replace(/```/g, ""),
  );

  const lines = noFence.replace(/\r/g, "").split("\n");
  const cleaned = lines
    .filter((line) => !/^\s*\|?\s*[-:]{2,}[|\s:-]*\s*$/.test(line))
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s*/g, "")
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\|/g, " ")
        .replace(/^\s*[-*+]\s+/g, "- "),
    );

  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildConversationWindow(messages: ChatMessage[], prompt: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const msg of messages) {
    if (msg.role === "user" || msg.role === "assistant") {
      const clean = toPlainText(msg.text || "").trim();
      if (clean && clean.toLowerCase() !== "thinking...") {
        const cap = msg.role === "assistant" && isListingResponse(clean) ? 8000 : 1200;
        turns.push({ role: msg.role, text: clean.slice(0, cap) });
      }
    }
  }
  turns.push({ role: "user", text: prompt.slice(0, 1200) });
  return turns.slice(-12);
}

type CachedChatState = {
  messages: ChatMessage[];
  sessionId: string;
};

const chatStateCache: Partial<Record<ChatMode, CachedChatState>> = {};

export function useChat(mode: ChatMode) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => chatStateCache[mode]?.messages ?? []);
  const [connected, setConnected] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [sessionId, setSessionId] = useState<string>(() => chatStateCache[mode]?.sessionId ?? crypto.randomUUID());
  const wsRef = useRef<ChatWebSocketClient | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const cancelledRequestIdsRef = useRef<Set<string>>(new Set());
  const processingWatchdogRef = useRef<number | null>(null);
  const sessionIdRef = useRef<string>(sessionId);
  const streamQueuesRef = useRef<Record<string, string[]>>({});
  const streamTimersRef = useRef<Record<string, number | null>>({});
  const streamEndedRef = useRef<Set<string>>(new Set());

  const clearStreamTimer = (requestId: string) => {
    const timerId = streamTimersRef.current[requestId];
    if (timerId) {
      window.clearTimeout(timerId);
      streamTimersRef.current[requestId] = null;
    }
  };

  const finalizeStreamMessage = (requestId: string, timeframeLabel?: string) => {
    setMessages((prev) =>
      prev.map((item) =>
        item.role === "assistant" && item.requestId === requestId
          ? { ...item, pending: false, timeframeLabel: timeframeLabel ?? item.timeframeLabel }
          : item,
      ),
    );
    streamEndedRef.current.delete(requestId);
    delete streamQueuesRef.current[requestId];
    clearStreamTimer(requestId);
  };

  const clearPendingStatusMessage = (requestId?: string) => {
    if (!requestId) {
      return;
    }

    setMessages((prev) =>
      prev.filter(
        (item) => !(item.role === "system" && item.pending && item.requestId === requestId),
      ),
    );
  };

  const scheduleStreamDrain = (requestId: string, timeframeLabel?: string) => {
    if (streamTimersRef.current[requestId]) {
      return;
    }

    const drain = () => {
      const queue = streamQueuesRef.current[requestId] ?? [];
      if (queue.length === 0) {
        streamTimersRef.current[requestId] = null;
        if (streamEndedRef.current.has(requestId)) {
          finalizeStreamMessage(requestId, timeframeLabel);
        }
        return;
      }

      const nextToken = queue.shift() ?? "";
      streamQueuesRef.current[requestId] = queue;

      setMessages((prev) => {
        const idx = prev.findIndex((item) => item.role === "assistant" && item.requestId === requestId);
        if (idx < 0) {
          return [
            ...prev,
            {
              id: `resp-${requestId}`,
              requestId,
              role: "assistant",
              text: nextToken,
              timeframeLabel,
              timestamp: asIsoTime(),
              pending: true,
            },
          ];
        }

        const updated = [...prev];
        updated[idx] = {
          ...updated[idx],
          text: `${updated[idx].text}${nextToken}`,
          pending: true,
          timeframeLabel: timeframeLabel ?? updated[idx].timeframeLabel,
        };
        return updated;
      });

      streamTimersRef.current[requestId] = window.setTimeout(drain, 16);
    };

    streamTimersRef.current[requestId] = window.setTimeout(drain, 16);
  };

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    chatStateCache[mode] = {
      messages,
      sessionId,
    };
  }, [messages, mode, sessionId]);

  const requestContinuation = async (continuationToken: string) => {
    const nextRequestId = makeId();
    activeRequestIdRef.current = nextRequestId;
    cancelledRequestIdsRef.current.delete(nextRequestId);
    setIsProcessing(true);

    try {
      if (!wsRef.current?.isOpen()) {
        await wsRef.current?.connect();
        setConnected(true);
      }

      const idToken = await getIdToken().catch(() => undefined);
      wsRef.current?.send({
        action: routeAction,
        requestId: nextRequestId,
        sessionId: sessionIdRef.current,
        prompt: "continue pagination",
        mode,
        lookbackHours: mode === "analyzer" ? appConfig.defaultAnalysisLookbackHours : undefined,
        continuationToken,
        idToken,
      });
    } catch {
      activeRequestIdRef.current = null;
      setIsProcessing(false);
      setMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          role: "system",
          text: "Unable to fetch the next page. Please retry.",
          timestamp: asIsoTime(),
        },
      ]);
    }
  };

  const routeAction = mode === "assistant" ? "calculator" : "analyzer";

  useEffect(() => {
    if (processingWatchdogRef.current) {
      window.clearTimeout(processingWatchdogRef.current);
      processingWatchdogRef.current = null;
    }

    if (!isProcessing || mode !== "analyzer") {
      return;
    }

    processingWatchdogRef.current = window.setTimeout(() => {
      const activeRequestId = activeRequestIdRef.current;
      activeRequestIdRef.current = null;
      setIsProcessing(false);
      setMessages((prev) => [
        ...prev.filter((item) => !(item.pending && (!activeRequestId || item.id === activeRequestId || item.requestId === activeRequestId))),
        {
          id: makeId(),
          role: "system",
          text: "Observability & Evaluation is taking too long. Please retry or narrow the timeframe.",
          timestamp: asIsoTime(),
        },
      ]);
    }, 70000);

    return () => {
      if (processingWatchdogRef.current) {
        window.clearTimeout(processingWatchdogRef.current);
        processingWatchdogRef.current = null;
      }
    };
  }, [isProcessing, mode]);

  useEffect(() => {
    let disposed = false;
    const ws = new ChatWebSocketClient(appConfig.websocketApiUrl);
    wsRef.current = ws;

    ws
      .connect()
      .then(() => {
        if (disposed) {
          return;
        }
        setConnected(true);
        setMessages((prev) => {
          const withoutConnectionErrors = prev.filter((msg) => msg.text !== "Unable to connect to websocket API.");
          if (withoutConnectionErrors.length > 0) {
            return withoutConnectionErrors;
          }

          return [
            {
              id: makeId(),
              role: "system",
              text:
                mode === "assistant"
                  ? "Connected. Ask anything to start chatting."
                  : "Welcome to Observability & Evaluation. I can summarize users/sessions/traces, compare performance, and inspect latency/errors for the last 30 days by default. Type / to see shortcut prompts.",
              timestamp: asIsoTime(),
            },
          ];
        });
      })
      .catch(() => {
        if (disposed) {
          return;
        }
        setMessages([
          {
            id: makeId(),
            role: "system",
            text: "Unable to connect to websocket API.",
            timestamp: asIsoTime(),
          },
        ]);
      });

    const unsubscribe = ws.onMessage((payload: InboundChatPayload) => {
      if (payload.requestId && cancelledRequestIdsRef.current.has(payload.requestId)) {
        return;
      }

      const rawMessage = (payload.message ?? payload.answer ?? "").toString();
      const isTransientGatewayTimeout = /endpoint request timed out/i.test(rawMessage);
      if (mode === "analyzer" && isTransientGatewayTimeout) {
        // Analyzer may still complete via websocket chunks even when API Gateway route returns timeout.
        return;
      }

      if (payload.type === "status_update") {
        const requestId = payload.requestId;
        const status = payload.status ?? "Processing...";

        setMessages((prev) => {
          const idx = prev.findIndex(
            (item) => item.role === "system" && item.pending && item.requestId === requestId,
          );
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = {
              ...updated[idx],
              text: status,
              pending: true,
              timestamp: asIsoTime(),
            };
            return updated;
          }
          return [
            ...prev,
            {
              id: makeId(),
              requestId,
              role: "system",
              text: status,
              pending: true,
              timestamp: asIsoTime(),
            },
          ];
        });
        return;
      }

      if (payload.type === "error") {
        const message = payload.message ?? "Unexpected error";
        clearPendingStatusMessage(payload.requestId);

        if (payload.requestId && activeRequestIdRef.current === payload.requestId) {
          activeRequestIdRef.current = null;
          setIsProcessing(false);
        }
        if (!payload.requestId) {
          activeRequestIdRef.current = null;
          setIsProcessing(false);
          setMessages((prev) =>
            prev.filter(
              (item) => !(item.pending || (item.role === "assistant" && item.text.trim() === "Thinking...")),
            ),
          );
        }
        setMessages((prev) => [
          ...prev,
          {
            id: makeId(),
            role: "system",
            text: message,
            timestamp: asIsoTime(),
          },
        ]);
        return;
      }

      if (payload.type === "assistant_response_chunk") {
        const requestId = payload.requestId ?? makeId();
        const chunk = payload.answerChunk ?? "";
        clearPendingStatusMessage(requestId);

        const tokens = chunk.match(/\S+\s*/g) ?? [chunk];
        const queue = streamQueuesRef.current[requestId] ?? [];
        streamQueuesRef.current[requestId] = [...queue, ...tokens];
        scheduleStreamDrain(requestId, payload.timeframeLabel);
        return;
      }

      if (payload.type === "assistant_response_end") {
        const requestId = payload.requestId;
        clearPendingStatusMessage(requestId);
        if (payload.continuationToken) {
          void requestContinuation(payload.continuationToken);
        } else if (requestId && activeRequestIdRef.current === requestId) {
          activeRequestIdRef.current = null;
          setIsProcessing(false);
        }

        if (requestId) {
          streamEndedRef.current.add(requestId);
          const queue = streamQueuesRef.current[requestId] ?? [];
          if (queue.length === 0 && !streamTimersRef.current[requestId]) {
            finalizeStreamMessage(requestId, payload.timeframeLabel);
          }
        }
        return;
      }

      if (payload.sessionId) {
        setSessionId(payload.sessionId);
      }

      if (payload.requestId && activeRequestIdRef.current === payload.requestId) {
        if (!payload.continuationToken) {
          activeRequestIdRef.current = null;
          setIsProcessing(false);
        }
      }

      const answer = (payload.answer ?? payload.message ?? "No response text returned").trim();

      setMessages((prev) => {
        const replaced = prev.filter(
          (item) => !(
            (item.pending && (!payload.requestId || item.id === payload.requestId || item.requestId === payload.requestId)) ||
            (item.role === "assistant" && item.text.trim() === "Thinking...")
          ),
        );
        return [
          ...replaced,
          {
            id: makeId(),
            requestId: payload.requestId,
            role: "assistant",
            text: answer,
            timeframeLabel: payload.timeframeLabel,
            timestamp: asIsoTime(),
          },
        ];
      });

      if (payload.continuationToken) {
        void requestContinuation(payload.continuationToken);
      }
    });

    return () => {
      disposed = true;
      Object.keys(streamTimersRef.current).forEach((requestId) => {
        clearStreamTimer(requestId);
      });
      streamQueuesRef.current = {};
      streamEndedRef.current.clear();
      unsubscribe();
      ws.disconnect();
      setConnected(false);
    };
  }, [mode, routeAction]);

  const sendPrompt = useMemo(
    () =>
      async (prompt: string): Promise<void> => {
        const requestId = makeId();
        activeRequestIdRef.current = requestId;
        cancelledRequestIdsRef.current.delete(requestId);
        setIsProcessing(true);

        setMessages((prev) => [
          ...prev,
          {
            id: makeId(),
            role: "user",
            text: prompt,
            timestamp: asIsoTime(),
          },
        ]);

        try {
          if (!wsRef.current?.isOpen()) {
            await wsRef.current?.connect();
            setConnected(true);
          }

          const idToken = await getIdToken().catch(() => undefined);

          wsRef.current?.send({
            action: routeAction,
            requestId,
            sessionId,
            prompt,
            mode,
            lookbackHours:
              mode === "analyzer" ? appConfig.defaultAnalysisLookbackHours : undefined,
            conversation: mode === "analyzer" ? buildConversationWindow(messages, prompt) : undefined,
            idToken,
          });
        } catch {
          activeRequestIdRef.current = null;
          setIsProcessing(false);
          setMessages((prev) => [
            ...prev.filter((item) => !(item.pending && item.id === requestId)),
            {
              id: makeId(),
              role: "system",
              text: "Unable to send request. Please try again.",
              timestamp: asIsoTime(),
            },
          ]);
        }
      },
    [messages, mode, routeAction, sessionId],
  );

  const startNewSession = () => {
    activeRequestIdRef.current = null;
    cancelledRequestIdsRef.current.clear();
    setIsProcessing(false);
    setSessionId(crypto.randomUUID());
    setMessages([
      {
        id: makeId(),
        role: "system",
        text: "Started a new session.",
        timestamp: asIsoTime(),
      },
    ]);
  };

  const stopCurrentRequest = () => {
    const activeRequestId = activeRequestIdRef.current;
    if (!activeRequestId) {
      return;
    }

    cancelledRequestIdsRef.current.add(activeRequestId);
    activeRequestIdRef.current = null;
    setIsProcessing(false);

    setMessages((prev) => {
      // Keep partial responses but mark them as complete; only remove pure "Thinking..." placeholders
      const updated = prev.map((item) => {
        if (item.pending && (item.id === activeRequestId || item.requestId === activeRequestId)) {
          if (item.role === "assistant" && item.text.trim() === "Thinking...") {
            return null; // remove empty thinking placeholder
          }
          return { ...item, pending: false }; // keep partial content
        }
        return item;
      }).filter(Boolean) as typeof prev;

      return [
        ...updated,
        {
          id: makeId(),
          role: "system",
          text: "Stopped.",
          timestamp: asIsoTime(),
        },
      ];
    });
  };

  return {
    connected,
    isProcessing,
    messages,
    sendPrompt,
    stopCurrentRequest,
    startNewSession,
  };
}
