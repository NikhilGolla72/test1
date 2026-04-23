import { ChatComposer } from "../components/chat/ChatComposer";
import { MessageList } from "../components/chat/MessageList";
import { useChat } from "../hooks/useChat";
import { useEffect, useRef } from "react";

const chatLayoutStyles = `
.chat-layout {
  flex: 1;
}

.chat-layout__messages {
  max-width: 720px;
  width: 100%;
  margin: 0 auto;
  padding: 8px 0 24px;
}

.chat-layout__composer-fixed {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 900;
  padding: 12px 24px 16px;
  background: linear-gradient(to top, #0072db 60%, #0072dbcc 80%, transparent);
}

.chat-layout__composer-inner {
  max-width: 720px;
  width: 100%;
  margin: 0 auto;
}

@media (max-width: 640px) {
  .chat-layout__composer-fixed { padding: 8px 12px 12px; }
}
`;

interface Props {
  onNewSessionReady: (fn: () => void) => void;
}

export function AssistantChatPage({ onNewSessionReady }: Props) {
  const chat = useChat("assistant");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onNewSessionReady(chat.startNewSession);
  }, [chat.startNewSession, onNewSessionReady]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.messages]);

  return (
    <>
      <style>{chatLayoutStyles}</style>
      <section className="chat-layout">
        <div className="chat-layout__messages">
          <MessageList messages={chat.messages} onSend={chat.sendPrompt} />
          <div ref={messagesEndRef} />
        </div>
      </section>
      <div className="chat-layout__composer-fixed">
        <div className="chat-layout__composer-inner">
          <ChatComposer
            textareaId="assistant-chat-textarea"
            placeholder="Ask me anything..."
            onSend={chat.sendPrompt}
            canStop={chat.isProcessing}
            onStop={chat.stopCurrentRequest}
            enableShortcuts={false}
          />
        </div>
      </div>
    </>
  );
}
