import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { type WlsCredentials } from '@/api/client'
import { AuthContext, type AuthContextValue } from './auth-context'
import {
  clearActiveConnectionSession,
  readActiveConnectionSession,
  writeActiveConnectionSession,
} from './connection-profiles'

function readStored(): WlsCredentials | null {
  return readActiveConnectionSession()
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [creds, setCreds] = useState<WlsCredentials | null>(() => readStored())
  const queryClient = useQueryClient()

  useEffect(() => {
    if (creds) writeActiveConnectionSession(creds)
    else clearActiveConnectionSession()
  }, [creds])

  const value = useMemo<AuthContextValue>(
    () => ({
      creds,
      // In-flight reads are cancelled first so none of them repopulates the cleared cache with
      // data read under the previous session.
      login: (c) => {
        void queryClient.cancelQueries()
        queryClient.clear()
        setCreds(c)
      },
      logout: () => {
        void queryClient.cancelQueries()
        queryClient.clear()
        setCreds(null)
      },
    }),
    [creds, queryClient],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
