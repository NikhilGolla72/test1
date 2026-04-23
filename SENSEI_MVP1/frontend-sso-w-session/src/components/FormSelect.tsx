import type { ChangeEvent, ReactNode } from 'react'

interface FormSelectProps {
  id: string
  label?: string
  value: string
  onChange: (e: ChangeEvent<HTMLSelectElement>) => void
  options: Array<{ id: string; label: string }>
  disabled?: boolean
  className?: string
  ariaLabel?: string
  required?: boolean
}

export function FormSelect({
  id,
  label,
  value,
  onChange,
  options,
  disabled = false,
  className = '',
  ariaLabel,
  required = false,
}: FormSelectProps) {
  return (
    <div className={`form-group ${className}`}>
      {label && (
        <label htmlFor={id} className="form-label">
          {label}
          {required && <span className="required-indicator">*</span>}
        </label>
      )}
      <select
        id={id}
        value={value}
        onChange={onChange}
        className="login-select"
        aria-label={ariaLabel || label}
        disabled={disabled}
        required={required}
      >
        {options.map(option => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}

interface FormFieldProps {
  className?: string
  children: ReactNode
}

export function FormField({ className = '', children }: FormFieldProps) {
  return <div className={`form-group ${className}`}>{children}</div>
}
