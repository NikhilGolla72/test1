/**
 * ProtectedRoute — Route guard component for authenticated pages.
 *
 * Wraps a route's element to enforce:
 *   1. Authentication: Redirects to /login if the user has no valid tokens.
 *   2. Role-based access: If allowedRoles is specified, checks the user's role
 *      against the list. Redirects to /unauthorized if the role doesn't match.
 *
 * Usage in App.tsx:
 *   <ProtectedRoute allowedRoles={['admin', 'pricing']}>
 *     <Home />
 *   </ProtectedRoute>
 */

import { Navigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { authService } from '../auth/authService'

interface ProtectedRouteProps {
  children: ReactNode
  allowedRoles?: string[] // If omitted, any authenticated user can access
}

export default function ProtectedRoute({ children, allowedRoles }: ProtectedRouteProps) {
  // Step 1: Check if user is authenticated (tokens exist and not expired)
  if (!authService.isAuthenticated()) {
    console.log('[ProtectedRoute] User not authenticated, redirecting to login')
    return <Navigate to="/login" replace />
  }

  // Step 2: Check if user has one of the required roles (if specified)
  if (allowedRoles && allowedRoles.length > 0) {
    const userRole = authService.getUserRole()
    if (!userRole || !allowedRoles.includes(userRole)) {
      console.log('[ProtectedRoute] User does not have required role, redirecting to unauthorized')
      return <Navigate to="/unauthorized" replace />
    }
  }

  // User is authenticated and authorized — render the protected content
  console.log('[ProtectedRoute] User authenticated and authorized, allowing access')
  return <>{children}</>
}
