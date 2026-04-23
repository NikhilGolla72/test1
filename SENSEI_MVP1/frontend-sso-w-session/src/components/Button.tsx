import type { ReactNode, ButtonHTMLAttributes } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode
  isLoading?: boolean
  variant?: 'primary' | 'secondary' | 'danger'
  size?: 'small' | 'medium' | 'large'
  fullWidth?: boolean
  loadingText?: string
}

export function Button({
  children,
  isLoading = false,
  variant = 'primary',
  size = 'medium',
  fullWidth = false,
  loadingText = 'Loading...',
  className = '',
  disabled,
  ...props
}: ButtonProps) {
  const classes = [
    'login-button',
    `btn-variant-${variant}`,
    `btn-size-${size}`,
    fullWidth && 'btn-full-width',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      {...props}
      className={classes}
      disabled={disabled || isLoading}
      aria-busy={isLoading}
    >
      {isLoading ? loadingText : children}
    </button>
  )
}
