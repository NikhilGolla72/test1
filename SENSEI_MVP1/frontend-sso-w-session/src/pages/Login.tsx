/**
 * Login Page — Entry point for unauthenticated users.
 *
 * Behavior:
 *   1. On mount, checks if the user is already authenticated (tokens in localStorage).
 *      If yes, redirects to /home immediately.
 *   2. If not authenticated, shows the "Sign in with SSO" button.
 *   3. Clicking the button calls authService.login() which redirects to the
 *      Cognito Hosted UI for SSO authentication.
 *
 * The 150ms delay before the auth check ensures any in-progress callback
 * (from a concurrent tab) has time to write tokens to localStorage.
 */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardHeader, Button } from '../components/index.tsx'
import { authService } from '../auth/authService.ts'
import Footer from '../components/Footer'
import '../styles/Login.css'

export default function Login() {
  const navigate = useNavigate()
  const [isChecking, setIsChecking] = useState(true)

  // Check if user is already authenticated
  useEffect(() => {
    const checkAuth = async () => {
      // Add a small delay to ensure any ongoing callback has completed
      await new Promise(resolve => setTimeout(resolve, 150));
      
      if (authService.isAuthenticated()) {
        console.log('[Login] User already authenticated, redirecting to home');
        navigate('/home', { replace: true })
      } else {
        console.log('[Login] User not authenticated, showing login form');
        setIsChecking(false)
      }
    }
    
    checkAuth()
  }, [navigate])

  const handleSSOLogin = () => {
    console.log('[Login] Initiating SSO login')
    authService.login()
  }

  // Show loading while checking authentication
  if (isChecking) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
        <div className="login-container" style={{ backgroundColor: '#0066B3', flex: 1 }}>
          <Card style={{ backgroundColor: '#004A8F', border: 'none' }}>
            <div style={{ 
              padding: '3rem', 
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '1rem'
            }}>
              <div style={{
                width: '40px',
                height: '40px',
              border: '4px solid #f3f3f3',
              borderTop: '4px solid white',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite',
            }} />
            <p style={{ color: 'white', margin: 0 }}>Loading...</p>
          </div>
          <style>{`
            @keyframes spin {
              0% { transform: rotate(0deg); }
              100% { transform: rotate(360deg); }
            }
          `}</style>
          </Card>
        </div>
        <Footer />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <div className="login-container" style={{ backgroundColor: '#0066B3', flex: 1 }}>
        <Card style={{ backgroundColor: '#004A8F', border: 'none' }}>
        <CardHeader>
          <h1 style={{ color: 'white' }}>PHILIPS SENSEI - SSO and Sessions</h1>
        </CardHeader>

        <div className="login-form" style={{ padding: '2rem 0' }}>
          <Button
            type="button"
            onClick={handleSSOLogin}
            className="btn-full-width"
            style={{
              backgroundColor: 'white',
              color: '#0066B3',
              padding: '14px 32px',
              fontSize: '16px',
              fontWeight: 'bold',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '12px',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.backgroundColor = '#f0f9ff'
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.backgroundColor = 'white'
            }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z" fill="#0066B3"/>
            </svg>
            Sign in with SSO
          </Button>
        </div>
        </Card>
      </div>
      <Footer />
    </div>
  )
}
