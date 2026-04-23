import { Link, useLocation } from "react-router-dom";
import { signOut } from "aws-amplify/auth";
import type { ReactNode } from "react";

const appShellStyles = `
.app-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.top-nav {
  position: sticky;
  top: 0;
  z-index: 1000;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 8px 24px;
  background: var(--bg-secondary);
}

.top-nav__left {
  display: flex;
  align-items: center;
  gap: 4px;
}

.top-nav__right {
  display: flex;
  align-items: center;
  gap: 4px;
}

.top-nav__brand {
  font-size: 16px;
  font-weight: 700;
  line-height: 24px;
  color: var(--text);
  margin-right: 12px;
  white-space: nowrap;
}

.top-nav__brand-accent {
  font-weight: 350;
  margin-left: 6px;
}

.nav-tab {
  color: rgba(255, 255, 255, 0.8);
  text-decoration: none;
  font-size: 14px;
  line-height: 20px;
  font-weight: 350;
  padding: 6px 14px;
  border-radius: 999px;
  transition: background 0.15s, color 0.15s;
}

.nav-tab:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text);
}

.nav-tab--active {
  background: rgba(255, 255, 255, 0.2);
  color: var(--text);
  font-weight: 700;
}

.nav-action {
  border: none;
  border-radius: 999px;
  background: transparent;
  color: rgba(255, 255, 255, 0.8);
  padding: 6px 14px;
  font-size: 14px;
  line-height: 20px;
  font-weight: 350;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  font-family: inherit;
}

.nav-action:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text);
}

.app-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 960px;
  margin: 0 auto;
  padding: 0 24px;
  padding-bottom: 130px;
}

@media (max-width: 640px) {
  .top-nav { padding: 6px 12px; }
  .nav-tab, .nav-action { font-size: 13px; padding: 5px 10px; }
  .app-main { padding: 0 12px; padding-bottom: 120px; }
}
`;

interface Props {
  children: ReactNode;
  onNewSession: () => void;
  analyzerHelpVisible?: boolean;
  onToggleAnalyzerHelp?: () => void;
}

export function AppShell({ children, onNewSession, analyzerHelpVisible, onToggleAnalyzerHelp }: Props) {
  const location = useLocation();
  const onAnalyzerPage =
    location.pathname === "/observability-&-evaluation" ||
    location.pathname.startsWith("/observability-&-evaluation/");

  const tabClass = (path: string) =>
    location.pathname === path ? "nav-tab nav-tab--active" : "nav-tab";

  return (
    <div className="app-shell">
      <style>{appShellStyles}</style>
      <header className="top-nav">
        <div className="top-nav__left">
          <strong className="top-nav__brand">
            PHILIPS<span className="top-nav__brand-accent">SENSEI</span>
          </strong>
          {/* <Link className={tabClass("/assistant")} to="/assistant">Assistant</Link> */}
          <Link className={tabClass("/observability-&-evaluation")} to="/observability-&-evaluation">
            Observability & Evaluation
          </Link>
        </div>
        <div className="top-nav__right">
          {/* {onAnalyzerPage && onToggleAnalyzerHelp && (
            <button className="nav-action" onClick={onToggleAnalyzerHelp} type="button">
              {analyzerHelpVisible ? "Close help" : "Help"}
            </button>
          )} */}
          <button className="nav-action" onClick={onNewSession} type="button">New session</button>
          {/* <button className="nav-action" onClick={() => signOut()} type="button">Sign out</button> */}
        </div>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
