/**
 * Home Page — Main dashboard shown after successful authentication.
 *
 * Displays:
 *   - Hero banner with the user's name and role
 *   - Module cards filtered by the user's role (non-clickable, display only)
 *   - Each module shows its title, description, icon, and access level
 *
 * The visible modules are determined by comparing the user's role against
 * each module's allowed roles list. Access labels (Full access / View only)
 * are computed per-role.
 *
 * If the user's role is 'unauthorized', they're redirected to /unauthorized.
 */

import { TopNavbar } from '../components/index.tsx'
import { Navigate } from 'react-router-dom'
import { tokenManager } from '../auth/tokenManager'
import { useEffect, useState } from 'react'
import Footer from '../components/Footer.tsx'
import '../styles/Home.css'

// SVG icons for each module
const icons = {
  pricing: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  ),
  catalog: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" />
    </svg>
  ),
  approval: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  ),
  threshold: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  ),
  terms: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  sow: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
    </svg>
  ),
}

const allRoles = ['admin', 'pricing', 'catalog', 'approver_data', 'bu_manager']

interface Module {
  key: string
  title: string
  description: string
  path: string
  icon: React.ReactNode
  roles: string[]
  accessLabel: (role: string) => string
}

const modules: Module[] = [
  {
    key: 'pricing',
    title: 'Service Pricing',
    description: 'Upload, manage, and version pricing files for services.',
    path: '/pricing',
    icon: icons.pricing,
    roles: allRoles,
    accessLabel: (r) => (r === 'admin' || r === 'pricing' ? 'Full access' : 'View only'),
  },
  {
    key: 'catalog',
    title: 'Service Catalog',
    description: 'Maintain the service catalog with file uploads and versioning.',
    path: '/catalog',
    icon: icons.catalog,
    roles: allRoles,
    accessLabel: (r) => (r === 'admin' || r === 'catalog' ? 'Full access' : 'View only'),
  },
  {
    key: 'approval',
    title: 'Approval Matrix',
    description: 'Configure and review approval workflows and thresholds.',
    path: '/approval-matrix',
    icon: icons.approval,
    roles: ['admin', 'approver_data'],
    accessLabel: (r) => (r === 'admin' || r === 'approver_data' ? 'Full access' : 'View only'),
  },
  {
    key: 'threshold',
    title: 'BU Threshold',
    description: 'Set and manage business-unit level threshold configurations.',
    path: '/bu-threshold',
    icon: icons.threshold,
    roles: ['admin', 'bu_manager', 'approver_data'],
    accessLabel: (r) => (r === 'admin' || r === 'bu_manager' ? 'Full access' : 'View only'),
  },
  {
    key: 'terms',
    title: 'Terms and Condition',
    description: 'Review and manage terms and conditions documents.',
    path: '/terms-and-condition',
    icon: icons.terms,
    roles: allRoles,
    accessLabel: () => 'Full access',
  },
  {
    key: 'sow',
    title: 'Statement of Work',
    description: 'Access and manage statement of work documents.',
    path: '/statement-of-work',
    icon: icons.sow,
    roles: allRoles,
    accessLabel: () => 'Full access',
  },
]


export default function Home() {
  const [userInfo, setUserInfo] = useState<{ email: string; role: string; name?: string } | null>(null)

  useEffect(() => {
    setUserInfo(tokenManager.getUserInfo())
  }, [])

  const userRole = (userInfo?.role || 'guest').toLowerCase()
  const userEmail = userInfo?.email || ''
  const userName = userInfo?.name || userEmail

  if (userRole === 'unauthorized') {
    return <Navigate to="/unauthorized" replace />
  }

  const visibleModules = modules.filter((m) => m.roles.includes(userRole))

  return (
    <div className="home-page">
      <TopNavbar userLabel={userName} />

      <div className="home-content">
        {/* Hero banner */}
        <div className="home-hero">
          <div className="home-hero-text">
            <p style={{ fontSize: '0.85rem', opacity: 0.75, marginBottom: '0.25rem' }}>Welcome back, {userName.split(' ')[0]}</p>
            <h1 style={{ fontSize: '1.75rem', marginBottom: '0.35rem' }}>PHILIPS SENSEI</h1>
            
          </div>
          <div className="home-hero-badge">
            <span className="role-chip">{userRole.replace('_', ' ')}</span>
          </div>
        </div>

        {/* Modules */}
        <h2 className="home-section-title">Modules</h2>
        <div className="home-modules">
          {visibleModules.map((m) => (
            <div key={m.key} className="home-module-card" style={{ cursor: 'default' }}>
              <div className="home-module-icon">{m.icon}</div>
              <h3>{m.title}</h3>
              <p>{m.description}</p>
              <span className="home-module-access">{m.accessLabel(userRole)}</span>
            </div>
          ))}
        </div>
      </div>
      <Footer />
    </div>
  )
}
