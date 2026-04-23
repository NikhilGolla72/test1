/**
 * TopNavbar — Main navigation bar displayed on authenticated pages.
 *
 * Features:
 *   - Philips SENSEI logo/branding on the left
 *   - Navigation links (currently just Home)
 *   - User profile dropdown on the right with Sign Out action
 *
 * The Sign Out button calls authService.logout() which:
 *   1. Calls backend /ssologout to clear the server-side session
 *   2. Clears all local tokens
 *   3. Redirects to /login
 */

import { Link, useLocation } from 'react-router-dom'
import { useState } from 'react'
import { authService } from '../auth/authService'
import '../styles/TopNavbar.css'

interface TopNavbarProps {
  userLabel?: string // Display name shown next to the dropdown (defaults to 'User')
}

export function TopNavbar({ userLabel = 'User' }: TopNavbarProps) {
  const location = useLocation()
  const [isDropdownOpen, setIsDropdownOpen] = useState(false)

  // Helper to check if a nav link matches the current route (for active styling)
  const isActive = (path: string) => location.pathname === path

  const handleDropdownToggle = () => {
    setIsDropdownOpen(!isDropdownOpen)
  }

  const handleSignOut = () => {
    console.log('[TopNavbar] User signing out')
    setIsDropdownOpen(false)
    authService.logout() // Triggers full logout flow (backend + local + redirect)
  }

  return (
    <nav className="top-navbar">
      <div className="navbar-container">
        {/* Left side: Logo + navigation links */}
        <div className="navbar-left">
          <div className="navbar-logo">
            <span className="logo-text">PHILIPS</span>
            <span className="logo-brand">SENSEI</span>
          </div>
          <div className="navbar-links">
            <Link 
              to="/home" 
              className={`nav-link ${isActive('/home') ? 'active' : ''}`}
            >
              Home
            </Link>
          </div>
        </div>

        {/* Right side: User profile + dropdown menu */}
        <div className="navbar-right">
          <div className="user-menu">
            <div className="user-profile">
              <span className="user-label">{userLabel}</span>
              <button 
                className="user-dropdown" 
                aria-label="User menu"
                onClick={handleDropdownToggle}
              >
                ▼
              </button>
            </div>
            {/* Dropdown menu — only visible when toggled */}
            {isDropdownOpen && (
              <div className="dropdown-menu">
                <button className="dropdown-item" onClick={handleSignOut}>
                  Sign Out
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </nav>
  )
}
