/**
 * SessionModal — Full-screen overlay shown when a session is invalidated.
 *
 * Displayed for these invalidation reasons:
 *   - 'replaced' — Another browser logged in and replaced this session
 *   - 'idle'     — User was inactive for 30+ minutes
 *   - 'logout'   — User logged out from another tab
 *
 * NOT shown for 'new_tab' — that uses the dead tab overlay in App.tsx instead.
 *
 * The modal shows a "Session Ended" message with a spinner indicating
 * automatic redirect to login (happens after 3 seconds via useSessionMonitor).
 */

interface SessionModalProps {
  show: boolean;     // Whether the modal is visible
  message: string;   // Human-readable reason for session end
  onClose?: () => void; // Optional close handler (redirect happens automatically)
}

export default function SessionModal({ show, message }: SessionModalProps) {
  // Don't render anything if the modal isn't active
  if (!show) return null;

  return (
    // Full-screen dark overlay
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.7)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 9999,
    }}>
      {/* Modal card */}
      <div style={{
        backgroundColor: 'white',
        padding: '2rem',
        borderRadius: '8px',
        boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
        maxWidth: '400px',
        textAlign: 'center',
      }}>
        {/* Warning icon */}
        <div style={{
          width: '60px',
          height: '60px',
          margin: '0 auto 1rem',
          borderRadius: '50%',
          backgroundColor: '#FEF3C7',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#F59E0B"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        
        <h2 style={{
          fontSize: '1.25rem',
          fontWeight: '600',
          color: '#1F2937',
          marginBottom: '0.5rem',
        }}>
          Session Ended
        </h2>
        
        {/* Dynamic message based on invalidation reason */}
        <p style={{
          color: '#6B7280',
          marginBottom: '1.5rem',
        }}>
          {message}
        </p>
        
        {/* Redirect spinner indicator */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.5rem',
          color: '#9CA3AF',
          fontSize: '0.875rem',
        }}>
          <div style={{
            width: '16px',
            height: '16px',
            border: '2px solid #D1D5DB',
            borderTop: '2px solid #6B7280',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }} />
          <span>Redirecting to login...</span>
        </div>
      </div>

      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
