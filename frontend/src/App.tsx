// import "@aws-amplify/ui-react/styles.css";
// import { Authenticator } from "@aws-amplify/ui-react";
// import { signUp } from "aws-amplify/auth";
import { Navigate, Route, Routes } from "react-router-dom";
import { useRef, useState } from "react";
import { AppShell } from "./components/layout/AppShell";
import { AnalyzerChatPage } from "./pages/AnalyzerChatPage";
import { AssistantChatPage } from "./pages/AssistantChatPage";

// Authentication is disabled - no Cognito required.
// const DEMO_BYPASS_AUTH = true;

// const authenticatorFormFields = {
//   signUp: {
//     username: { order: 1, isRequired: true, placeholder: "Choose a username" },
//     email: { order: 2, isRequired: true, placeholder: "Enter your email" },
//     name: { order: 3, isRequired: true, label: "Full name", placeholder: "Enter your full name" },
//     password: { order: 4 },
//     confirm_password: { order: 5, label: "Confirm password" },
//   },
// };

// const authenticatorServices = {
//   async handleSignUp(input: any) {
//     const username = (input.username || "").trim();
//     const fullName = (input.options?.userAttributes?.name || "").trim();
//     const password = String(input.password || "");
//     return signUp({
//       username,
//       password,
//       options: {
//         ...input.options,
//         userAttributes: { ...input.options?.userAttributes, name: fullName || username },
//       },
//     });
//   },
// };

const appGlobalStyles = `
:root {
  /* Figma design tokens */
  --bg-primary: #0072db;
  --bg-secondary: #006cd1;
  --surface: rgba(255, 255, 255, 0.06);
  --surface-strong: rgba(255, 255, 255, 0.10);
  --text: #ffffff;
  --text-secondary: rgba(255, 255, 255, 0.75);
  --text-muted: #566676;
  --line: rgba(255, 255, 255, 0.32);
  --accent: #ffffff;
  --accent-strong: #f0f9ff;
  --user-bubble-bg: #0061c2;
  --button-primary: #0072db;
  --error: #eb0014;
}

* { box-sizing: border-box; }

html, body, #root {
  margin: 0;
  width: 100%;
  min-height: 100%;
  font-family: "Neue Frutiger One", "Segoe UI", "Inter", -apple-system, sans-serif;
  font-weight: 350;
  color: var(--text);
  font-size: 16px;
  line-height: 24px;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

body {
  background: var(--bg-primary);
}

* {
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.25) transparent;
}

*::-webkit-scrollbar { width: 6px; height: 6px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.25);
}
*::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.4);
}
`;

export default function App() {
  const newSessionRef = useRef<() => void>(() => undefined);
  const [showAnalyzerHelp, setShowAnalyzerHelp] = useState(false);

  const appContent = (
    <AppShell
      onNewSession={() => newSessionRef.current()}
      analyzerHelpVisible={showAnalyzerHelp}
      onToggleAnalyzerHelp={() => setShowAnalyzerHelp((prev) => !prev)}
    >
      <Routes>
        <Route
          path="/assistant"
          element={
            <AssistantChatPage onNewSessionReady={(fn) => { newSessionRef.current = fn; }} />
          }
        />
        <Route
          path="/observability-&-evaluation"
          element={
            <AnalyzerChatPage
              showHelp={showAnalyzerHelp}
              onCloseHelp={() => setShowAnalyzerHelp(false)}
              onNewSessionReady={(fn) => { newSessionRef.current = fn; }}
            />
          }
        />
        <Route path="*" element={<Navigate to="/observability-&-evaluation" replace />} />
      </Routes>
    </AppShell>
  );

  return (
    <>
      <style>{appGlobalStyles}</style>
      {appContent}
    </>
  );
}
