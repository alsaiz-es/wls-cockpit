import { Navigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from './useAuth'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { creds } = useAuth()
  if (!creds) return <Navigate to="/login" replace />
  return <>{children}</>
}
