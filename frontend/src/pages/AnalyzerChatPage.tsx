import { AnalyzerHelpPanel } from "../components/chat/AnalyzerHelpPanel";
import { ChatComposer } from "../components/chat/ChatComposer";
import { MessageList } from "../components/chat/MessageList";
import { useChat } from "../hooks/useChat";
import { useEffect, useRef } from "react";

const chatLayoutStyles = `
.chat-layout {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.chat-layout--with-help {
  flex-direction: row;
  gap: 1rem;
}

.chat-layout__primary {
  flex: 1;
  min-width: 0;
}

.chat-layout__messages {
  max-width: 780px;
  width: 100%;
  margin: 0 auto;
  padding: 0.5rem 0 1.5rem;
}

.chat-layout__composer-fixed {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 900;
  padding: 0.5rem 1.5rem 0.75rem;
  background: linear-gradient(to top, #0072db 70%, transparent);
}

.chat-layout__composer-inner {
  max-width: 680px;
  width: 100%;
  margin: 0 auto;
}

@media (max-width: 960px) {
  .chat-layout--with-help { flex-direction: column; }
}

@media (max-width: 640px) {
  .chat-layout__composer-fixed {
    padding: 0.4rem 0.75rem 0.6rem;
  }
}
`;

interface Props {
  onNewSessionReady: (fn: () => void) => void;
  showHelp: boolean;
  onCloseHelp?: () => void;
}

export function AnalyzerChatPage({ onNewSessionReady, showHelp, onCloseHelp }: Props) {
  const chat = useChat("analyzer");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onNewSessionReady(() => { chat.startNewSession(); });
  }, [chat.startNewSession, onNewSessionReady]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.messages]);

  return (
    <>
      <style>{chatLayoutStyles}</style>
      <section className={`chat-layout ${showHelp ? "chat-layout--with-help" : ""}`}>
        <div className="chat-layout__primary">
          <div className="chat-layout__messages">
            <MessageList messages={chat.messages} onSend={chat.sendPrompt} />
            <div ref={messagesEndRef} />
          </div>
        </div>
        {showHelp && <AnalyzerHelpPanel onClose={onCloseHelp} />}
      </section>
      <div className="chat-layout__composer-fixed">
        <div className="chat-layout__composer-inner">
          <ChatComposer
            textareaId="analyzer-chat-textarea"
            placeholder="Ask your analysis question..."
            onSend={chat.sendPrompt}
            canStop={chat.isProcessing}
            onStop={chat.stopCurrentRequest}
          />
        </div>
      </div>
    </>
  );
}
