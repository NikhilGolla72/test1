/**
 * Components barrel export — re-exports all shared UI components.
 *
 * Also defines inline UI primitives (Card, Button, Form, Select) used
 * primarily on the Login page. These are simple wrappers that apply
 * consistent CSS class names.
 */

import type { ReactNode, ButtonHTMLAttributes, ChangeEvent, CSSProperties } from 'react'

// ── Card Components (used on Login page) ─────────────────────────────────────

/** Card wrapper — applies the login-card CSS class */
export function Card({ children, className = '', style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return <div className={`login-card ${className}`} style={style}>{children}</div>
}

/** Card header section */
export function CardHeader({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`login-header ${className}`}>{children}</div>
}

/** Card footer section */
export function CardFooter({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`login-footer ${className}`}>{children}</div>
}

// ── Form Components ──────────────────────────────────────────────────────────

/** Form wrapper with onSubmit handler */
export function Form({ children, onSubmit, className = '' }: { children: ReactNode; onSubmit: (e: any) => void; className?: string }) {
  return (
    <form onSubmit={onSubmit} className={`login-form ${className}`}>
      {children}
    </form>
  )
}

interface SelectProps {
  id: string
  label?: string
  value: string
  onChange: (e: ChangeEvent<HTMLSelectElement>) => void
  options: Array<{ id: string; label: string }>
  disabled?: boolean
}

/** Styled select dropdown with optional label */
export function Select({ id, label, value, onChange, options, disabled }: SelectProps) {
  return (
    <div className="form-group">
      {label && <label htmlFor={id} className="form-label">{label}</label>}
      <select
        id={id}
        value={value}
        onChange={onChange}
        className="login-select"
        disabled={disabled}
      >
        {options.map(opt => (
          <option key={opt.id} value={opt.id}>{opt.label}</option>
        ))}
      </select>
    </div>
  )
}

// ── Button Component ─────────────────────────────────────────────────────────

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode
  isLoading?: boolean       // Show loading state
  loadingText?: string      // Text to display while loading
}

/** Styled button with loading state support */
export function Button({ children, isLoading, loadingText = 'Loading...', className = '', ...props }: ButtonProps) {
  return (
    <button
      {...props}
      className={`login-button ${className}`}
      disabled={props.disabled || isLoading}
      aria-busy={isLoading}
    >
      {isLoading ? loadingText : children}
    </button>
  )
}

// ── Re-exports from separate component files ─────────────────────────────────
export { TopNavbar } from './TopNavbar'
export { default as ProtectedRoute } from './ProtectedRoute'
export { default as SessionModal } from './SessionModal'
export { default as Footer } from './Footer'
