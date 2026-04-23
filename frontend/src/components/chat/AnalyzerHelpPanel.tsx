const analyzerHelpPanelStyles = `
.analyzer-help {
  border: 1px solid var(--line);
  border-radius: 0.75rem;
  background: rgba(255, 255, 255, 0.06);
  padding: 1rem 1.1rem;
  position: fixed;
  right: clamp(0.75rem, 2vw, 1.5rem);
  top: 5rem;
  width: min(280px, 28vw);
  max-height: 60vh;
  overflow: auto;
  z-index: 940;
}

.analyzer-help__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.analyzer-help h3 {
  margin: 0;
  font-size: 0.92rem;
  font-weight: 600;
}

.analyzer-help__close {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.82rem;
  line-height: 1;
  cursor: pointer;
  border-radius: 999px;
  padding: 0.2rem 0.45rem;
}

.analyzer-help__close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text);
}

.analyzer-help h4 {
  margin: 0.6rem 0 0.3rem;
  font-size: 0.84rem;
  font-weight: 600;
  color: var(--text);
}

.analyzer-help p {
  margin: 0 0 0.6rem;
  line-height: 1.55;
  font-size: 0.84rem;
  color: var(--text-secondary);
}

@media (max-width: 960px) {
  .analyzer-help {
    width: 100%;
    max-height: unset;
    position: static;
  }
}
`;

interface Props {
  onClose?: () => void;
}

export function AnalyzerHelpPanel({ onClose }: Props) {
  return (
    <>
      <style>{analyzerHelpPanelStyles}</style>
      <aside className="analyzer-help">
        <div className="analyzer-help__header">
          <h3>Observability & Evaluation help</h3>
          {onClose ? (
            <button type="button" className="analyzer-help__close" onClick={onClose} aria-label="Close help panel">
              Close
            </button>
          ) : null}
        </div>
        <h4>Fleet mode</h4>
        <p>Analyze patterns, summaries, and issues across many sessions in your selected timeframe.</p>
        <h4>Timeframes</h4>
        <p>Default window is 30 days. Ask to switch like "last 7 days" or "last 3 hours".</p>
        <h4>What to ask</h4>
        <p>Users with most errors, session traces, evaluator scores, token usage, and latency bottlenecks.</p>
      </aside>
    </>
  );
}
