import type { ChatMessage } from "../../types/chat";
import ReactMarkdown from "react-markdown";

const messageListStyles = `
.message-list {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 16px 0;
}

.msg {
  display: flex;
  animation: msg-in 200ms ease-out;
}

.msg--user { justify-content: flex-end; }
.msg--assistant, .msg--system { justify-content: flex-start; }

/* User bubble */
.msg__user-bubble {
  background: #0061c2;
  border: none;
  border-radius: 16px;
  padding: 4px 12px;
  max-width: min(520px, 80%);
  font-size: 16px;
  line-height: 24px;
  font-weight: 350;
  color: #ffffff;
}

/* Assistant row */
.msg__assistant-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 100%;
}

.msg__ai-icon {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  margin-top: 1px;
  opacity: 0.7;
  object-fit: contain;
}

.msg__ai-icon--animated {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  margin-top: 1px;
  object-fit: contain;
}

.msg__body {
  flex: 1;
  min-width: 0;
}

.msg__content {
  font-size: 16px;
  line-height: 24px;
  font-weight: 350;
  color: var(--text);
  overflow-wrap: anywhere;
}

.msg__content p { margin: 0; }

/* Markdown styles for assistant responses */
.msg__content p + p { margin-top: 12px; }

.msg__content h1, .msg__content h2, .msg__content h3,
.msg__content h4, .msg__content h5, .msg__content h6 {
  color: #ffffff;
  font-weight: 700;
  margin: 16px 0 8px;
  line-height: 1.3;
}

.msg__content h1 { font-size: 20px; }
.msg__content h2 { font-size: 18px; }
.msg__content h3 { font-size: 16px; }
.msg__content h4 { font-size: 15px; }

.msg__content h1:first-child,
.msg__content h2:first-child,
.msg__content h3:first-child {
  margin-top: 0;
}

.msg__content ul, .msg__content ol {
  margin: 8px 0;
  padding-left: 20px;
}

.msg__content li {
  margin: 4px 0;
  line-height: 24px;
}

.msg__content li > ul, .msg__content li > ol {
  margin: 2px 0;
}

.msg__content code {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 14px;
  font-family: "Cascadia Code", "Fira Code", "Consolas", monospace;
}

.msg__content pre {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 8px;
  padding: 12px 16px;
  margin: 12px 0;
  overflow-x: auto;
}

.msg__content pre code {
  background: none;
  padding: 0;
  border-radius: 0;
  font-size: 13px;
  line-height: 20px;
}

.msg__content blockquote {
  border-left: 3px solid rgba(255, 255, 255, 0.3);
  margin: 12px 0;
  padding: 4px 0 4px 16px;
  color: rgba(255, 255, 255, 0.8);
}

.msg__content table {
  border-collapse: collapse;
  margin: 12px 0;
  width: 100%;
  font-size: 14px;
}

.msg__content th, .msg__content td {
  border: 1px solid rgba(255, 255, 255, 0.15);
  padding: 6px 10px;
  text-align: left;
}

.msg__content th {
  background: rgba(255, 255, 255, 0.08);
  font-weight: 700;
}

.msg__content a {
  color: #a8d4ff;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.msg__content a:hover {
  color: #ffffff;
}

.msg__content hr {
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.15);
  margin: 16px 0;
}

.msg__content strong { font-weight: 700; }
.msg__content em { font-style: italic; }

/* System — small inline note */
.msg__system-text {
  font-size: 13px;
  line-height: 18px;
  font-weight: 350;
  color: rgba(255, 255, 255, 0.5);
  margin: 0;
  padding-left: 32px;
}

/* Welcome hero — shown before first real message */
.welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 80px 24px 40px;
  animation: msg-in 400ms ease-out;
}

.welcome__icon {
  width: 48px;
  height: 48px;
  opacity: 0.5;
  margin-bottom: 20px;
}

.welcome__title {
  font-size: 20px;
  font-weight: 700;
  line-height: 28px;
  color: #ffffff;
  margin: 0 0 8px;
}

.welcome__subtitle {
  font-size: 14px;
  line-height: 22px;
  font-weight: 350;
  color: rgba(255, 255, 255, 0.6);
  max-width: 420px;
  margin: 0 0 28px;
}

.welcome__hints {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
  max-width: 520px;
}

.welcome__hint {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 13px;
  line-height: 18px;
  color: rgba(255, 255, 255, 0.8);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  font-family: inherit;
}

.welcome__hint:hover {
  background: rgba(255, 255, 255, 0.16);
  color: #ffffff;
}

/* Thinking */
.thinking-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.thinking-row__icon {
  width: 24px;
  height: 24px;
  object-fit: contain;
}

.thinking-row__label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 14px;
  line-height: 20px;
  color: rgba(255, 255, 255, 0.7);
  font-weight: 350;
}

.thinking-row__dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.6);
  animation: dot-bounce 1.4s ease-in-out infinite;
}

.thinking-row__dot:nth-child(2) { animation-delay: 0s; }
.thinking-row__dot:nth-child(3) { animation-delay: 0.2s; }
.thinking-row__dot:nth-child(4) { animation-delay: 0.4s; }

@keyframes msg-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes dot-bounce {
  0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
  30% { opacity: 1; transform: translateY(-2px); }
}

@media (max-width: 640px) {
  .msg__user-bubble { max-width: 88%; }
}
`;

interface Props {
  messages: ChatMessage[];
  onSend?: (text: string) => Promise<void>;
}

const WELCOME_HINTS = [
  { label: "Session summary", prompt: "Give me a summary for the current timeframe" },
  { label: "Top errors", prompt: "Show me the users with the most errors" },
  { label: "Latency bottlenecks", prompt: "Show the top latency traces this week" },
  { label: "User activity", prompt: "List out all users with their session counts" },
  { label: "Trace deep dive", prompt: "List all session IDs for the last 30 days" },
];

export function MessageList({ messages, onSend }: Props) {
  const isThinking = (msg: ChatMessage) =>
    msg.role === "assistant" && msg.pending && msg.text.trim() === "Thinking...";

  const isStreaming = (msg: ChatMessage) =>
    msg.role === "assistant" && msg.pending && msg.text.trim() !== "Thinking...";

  // Show welcome hero when only system messages exist (no user/assistant messages yet)
  const hasRealMessages = messages.some((m) => m.role === "user" || m.role === "assistant");

  if (!hasRealMessages) {
    return (
      <>
        <style>{messageListStyles}</style>
        <div className="welcome">
          <img src="/Ai.svg" alt="" className="welcome__icon" />
          <h2 className="welcome__title">What can I help you analyze?</h2>
          <p className="welcome__subtitle">
            Summarize sessions, compare performance, inspect traces, and surface errors across your data.
          </p>
          <div className="welcome__hints">
            {WELCOME_HINTS.map((hint) => (
              <button
                key={hint.label}
                className="welcome__hint"
                type="button"
                onClick={() => onSend?.(hint.prompt)}
              >
                {hint.label}
              </button>
            ))}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <style>{messageListStyles}</style>
      <section className="message-list">
        {messages.map((msg) => {
          if (isThinking(msg)) {
            return (
              <div key={msg.id} className="msg msg--assistant">
                <div className="thinking-row">
                  <img src="/images/ai-animation-white-loop.gif" alt="" className="thinking-row__icon" />
                  <span className="thinking-row__label">
                    Thinking
                    <span className="thinking-row__dot" />
                    <span className="thinking-row__dot" />
                    <span className="thinking-row__dot" />
                  </span>
                </div>
              </div>
            );
          }

          if (msg.role === "user") {
            return (
              <div key={msg.id} className="msg msg--user">
                <div className="msg__user-bubble">{msg.text}</div>
              </div>
            );
          }

          if (msg.role === "system") {
            // Skip verbose welcome messages, show short ones
            if (msg.text.length > 60) return null;
            return (
              <div key={msg.id} className="msg msg--system">
                <p className="msg__system-text">{msg.text}</p>
              </div>
            );
          }

          const streaming = isStreaming(msg);

          return (
            <div key={msg.id} className="msg msg--assistant">
              <div className="msg__assistant-row">
                <img
                  src={streaming ? "/images/ai-animation-white-loop.gif" : "/Ai.svg"}
                  alt=""
                  className={streaming ? "msg__ai-icon--animated" : "msg__ai-icon"}
                />
                <div className="msg__body">
                  <div className="msg__content"><ReactMarkdown>{msg.text}</ReactMarkdown></div>
                </div>
              </div>
            </div>
          );
        })}
      </section>
    </>
  );
}
