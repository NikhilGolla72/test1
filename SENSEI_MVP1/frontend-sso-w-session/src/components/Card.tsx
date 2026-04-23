import type { ReactNode, CSSProperties } from 'react'

interface CardProps {
  className?: string
  children: ReactNode
  style?: CSSProperties
}

export function Card({ className = '', children, style }: CardProps) {
  return <div className={`login-card ${className}`} style={style}>{children}</div>
}

interface CardHeaderProps {
  className?: string
  children: ReactNode
}

export function CardHeader({ className = '', children }: CardHeaderProps) {
  return <div className={`login-header ${className}`}>{children}</div>
}

interface CardContentProps {
  className?: string
  children: ReactNode
}

export function CardContent({ className = '', children }: CardContentProps) {
  return <div className={`login-content ${className}`}>{children}</div>
}

interface CardFooterProps {
  className?: string
  children: ReactNode
}

export function CardFooter({ className = '', children }: CardFooterProps) {
  return <div className={`login-footer ${className}`}>{children}</div>
}
