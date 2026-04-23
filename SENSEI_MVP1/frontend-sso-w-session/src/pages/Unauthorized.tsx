/**
 * Unauthorized Page — Shown when a user authenticates via Cognito SSO but
 * is not found in the backend database (test-sensei-user-management table).
 *
 * This happens when /ssologin returns 403. The user's Cognito authentication
 * succeeded, but they don't have an entry in the system's user management table.
 *
 * Provides two options:
 *   - "Go Back" — Navigate to the previous page
 *   - "Go to Login" — Clear all tokens and redirect to /login
 */

import { useNavigate } from 'react-router-dom'
import { tokenManager } from '../auth/tokenManager'
import '../styles/Unauthorized.css'

export default function Unauthorized() {
  const navigate = useNavigate()

  const handleGoBack = () => {
    window.history.back()
  }

  const handleGoToLogin = () => {
    console.log('[Unauthorized] User not found in backend database - clearing session')
    
    // Clear all tokens and user info
    tokenManager.clearTokens()
    
    console.log('[Unauthorized] Session data cleared, navigating to login')
    
    // Navigate to login page
    navigate('/login', { replace: true })
  }

  return (
    <div className="unauthorized-container">
      <div className="unauthorized-content">
        <div className="error-code">403</div>
        <h1 className="error-title">User Not Authorized</h1>
        <p className="error-message">
          Your account was not found in the system database (dev-sensei-UserManagement). 
          Please contact your administrator to get access.
        </p>
        <div className="button-group">
          <button onClick={handleGoBack} className="goto-login-btn back-btn">
            Go Back
          </button>
          <button onClick={handleGoToLogin} className="goto-login-btn">
            Go to Login
          </button>
        </div>
      </div>
    </div>
  )
}
