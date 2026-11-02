import { createContext } from 'react'
import type { WlsCredentials } from '@/api/client'

export interface AuthContextValue {
  creds: WlsCredentials | null
  login: (c: WlsCredentials) => void
  logout: () => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)
