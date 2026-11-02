import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { type WlsCredentials } from '@/api/client'
import { onCredentialsRejected, writeSignInNotice } from '@/api/credential-rejection'
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

  // WebLogic rejected the password of this session (changed, expired or locked): sign out at once
  // so polling does not keep failing logins against the account.
  useEffect(
    () =>
      onCredentialsRejected(() => {
        writeSignInNotice(
          'WebLogic rejected the password of this session, so Cockpit signed out and stopped polling to avoid locking the account. Sign in again.',
        )
        void queryClient.cancelQueries()
        queryClient.clear()
        setCreds(null)
      }),
    [queryClient],
  )

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
