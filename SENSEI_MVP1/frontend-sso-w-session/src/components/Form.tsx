import type { FormHTMLAttributes, ReactNode } from 'react'

interface FormProps extends FormHTMLAttributes<HTMLFormElement> {
  children: ReactNode
  className?: string
}

export function Form({ children, className = '', ...props }: FormProps) {
  return (
    <form {...props} className={`login-form ${className}`}>
      {children}
    </form>
  )
}
