import { FormEvent, KeyboardEvent, useState } from "react";

const chatComposerStyles = `
.chat-composer {
  overflow: visible;
}

/* Outer translucent container — Figma: background/translucent/secondary */
.chat-composer__outer {
  background: #f0f9ffd6;
  backdrop-filter: blur(32px);
  -webkit-backdrop-filter: blur(32px);
  border-radius: 12px;
  padding: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Text field container */
.chat-composer__field {
  flex: 1;
  min-width: 0;
  position: relative;
}

/* Slash shortcut menu */
.chat-composer__slash-menu {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 8px);
  background: rgba(8, 47, 120, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);
  z-index: 120;
  max-height: 210px;
  overflow: auto;
  padding: 4px;
}

.chat-composer__slash-item {
  width: 100%;
  text-align: left;
  background: transparent;
  border: 0;
  color: rgba(255, 255, 255, 0.9);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  font-family: inherit;
}

.chat-composer__slash-item:hover {
  background: rgba(255, 255, 255, 0.08);
}

.chat-composer__slash-key {
  min-width: 60px;
  color: #8ec4ff;
  font-weight: 600;
}

.chat-composer__slash-label {
  color: rgba(255, 255, 255, 0.7);
}

.chat-composer__helper {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-muted);
  padding-left: 12px;
}

/* Inner text input — Figma: text-field component */
.chat-composer__input-box {
  background: #ffffff;
  border: 1px solid #6b8094;
  border-radius: 6px;
  display: flex;
  align-items: center;
  width: 100%;
  transition: border-color 0.15s;
}

.chat-composer__input-box:focus-within {
  border-color: #424f5c;
}

.chat-composer__input {
  width: 100%;
  border: none;
  outline: none;
  background: transparent;
  resize: none;
  padding: 8px 12px;
  color: #15191e;
  font-size: 16px;
  line-height: 24px;
  font-weight: 350;
  font-family: "Neue Frutiger One", "Segoe UI", "Inter", -apple-system, sans-serif;
  min-height: 24px;
  max-height: 120px;
  overflow-y: auto;
}

.chat-composer__input::placeholder {
  color: #566676;
}

/* Send / Stop button — matches Figma Button component (primary, icon-only, round) */
.chat-composer__send-btn {
  width: 32px;
  height: 32px;
  border-radius: 999px;
  border: none;
  background: #0072db;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  padding: 4px;
  transition: background 0.15s, transform 0.1s;
}

.chat-composer__send-btn:hover:not(:disabled) {
  background: #005fb8;
}

.chat-composer__send-btn:active:not(:disabled) {
  transform: scale(0.95);
}

.chat-composer__send-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.chat-composer__send-btn svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: #ffffff;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* Disclaimer — Figma: Reference/M */
.chat-composer__disclaimer {
  text-align: center;
  font-size: 12px;
  line-height: 18px;
  font-weight: 700;
  color: var(--text-secondary);
  margin: 8px 0 0;
}

@media (max-width: 640px) {
  .chat-composer__outer {
    padding: 6px;
    border-radius: 10px;
  }
  .chat-composer__input {
    font-size: 15px;
    padding: 7px 10px;
  }
  .chat-composer__send-btn {
    width: 30px;
    height: 30px;
  }
}
`;

interface Props {
  placeholder: string;
  onSend: (text: string) => Promise<void>;
  canStop?: boolean;
  onStop?: () => void;
  enableShortcuts?: boolean;
  textareaId?: string;
}

const MAX_TEXT = 4000;

const SLASH_SHORTCUTS: Array<{ key: string; label: string; prompt: string }> = [
  { key: "suggest", label: "Show prompt suggestions", prompt: "show prompt suggestions" },
  { key: "summary", label: "Summary (30d)", prompt: "give me a summary for the current timeframe" },
  { key: "users", label: "List all users", prompt: "list out all users" },
  { key: "sessions", label: "List all session IDs", prompt: "list out all the session ids" },
  { key: "7d", label: "Switch to 7d", prompt: "switch timeframe to last 7 days" },
  { key: "24h", label: "Switch to 24h", prompt: "switch timeframe to last 24 hours" },
];

export function ChatComposer({
  placeholder, onSend, canStop = false, onStop, enableShortcuts = true, textareaId,
}: Props) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);

  const slashQuery = enableShortcuts && value.startsWith("/") ? value.slice(1).trim().toLowerCase() : "";
  const slashItems = enableShortcuts && value.startsWith("/")
    ? SLASH_SHORTCUTS.filter(
        (item) => !slashQuery || item.key.includes(slashQuery) || item.label.toLowerCase().includes(slashQuery),
      ).slice(0, 6)
    : [];

  const sendCurrentValue = async () => {
    if (!value.trim() || sending || canStop) return;
    setSending(true);
    try { await onSend(value.trim()); setValue(""); } finally { setSending(false); }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await sendCurrentValue();
  };

  const handleKeyDown = async (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !canStop) {
      event.preventDefault();
      await sendCurrentValue();
    }
  };

  return (
    <>
      <style>{chatComposerStyles}</style>
      <form className="chat-composer" onSubmit={handleSubmit}>
        <div className="chat-composer__outer">
          <div className="chat-composer__field">
            {slashItems.length > 0 && (
              <div className="chat-composer__slash-menu" role="listbox" aria-label="Slash shortcuts">
                {slashItems.map((item) => (
                  <button key={item.key} className="chat-composer__slash-item" type="button"
                    onClick={() => setValue(item.prompt)}>
                    <span className="chat-composer__slash-key">/{item.key}</span>
                    <span className="chat-composer__slash-label">{item.label}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="chat-composer__input-box">
              <textarea
                id={textareaId}
                className="chat-composer__input"
                value={value}
                onChange={(e) => setValue(e.target.value.slice(0, MAX_TEXT))}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                disabled={canStop}
                rows={1}
              />
            </div>
          </div>
          {canStop ? (
            <button className="chat-composer__send-btn" type="button" onClick={onStop} aria-label="Stop">
              <svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="#ffffff" stroke="none" /></svg>
            </button>
          ) : (
            <button className="chat-composer__send-btn" type="submit" disabled={sending || !value.trim()} aria-label="Send">
              <svg viewBox="0 0 24 24">
                <path d="M5.4 19.5L20.1 12.9C20.5 12.7 20.5 12.1 20.1 11.9L5.4 5.3C5 5.1 4.6 5.4 4.7 5.8L6.3 11.5C6.4 11.8 6.6 12 6.9 12H12" />
                <path d="M6.3 13.3L4.7 19C4.6 19.4 5 19.7 5.4 19.5" />
              </svg>
            </button>
          )}
        </div>
        {slashItems.length > 0 && (
          <div className="chat-composer__helper">Press Enter to use selected slash shortcut text</div>
        )}
      </form>
      <p className="chat-composer__disclaimer">Philips AI may make mistakes, always double check responses.</p>
    </>
  );
}
