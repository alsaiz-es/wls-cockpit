import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, Check, Pencil, PlugZap, Plus, Trash2 } from 'lucide-react'
import { useAuth } from '@/auth/useAuth'
import { clearSignInNotice, readSignInNotice } from '@/api/credential-rejection'
import {
  activeConnectionFromProfile,
  createConnectionProfile,
  deleteConnectionProfile,
  listConnectionProfiles,
  markConnectionProfileUsed,
  persistConnectionProfileCatalog,
  seedDefaultConnectionProfile,
  syncConnectionProfileCatalog,
  updateConnectionProfile,
  type ConnectionProfile,
} from '@/auth/connection-profiles'
import { WLS_VERSIONS, type WlsVersion } from '@/api/wls-version'
import { normalizeWlsTarget } from '@/api/proxy-target'
import { readRuntimeConfig } from '@/api/runtime-config'
import { verifyWlsCredentials } from '@/api/verify-credentials'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { MonoText } from '@/components/mono-text'
import { cn } from '@/lib/utils'

const DEFAULT_CONFIG = readRuntimeConfig()
const DEFAULT_TARGET = DEFAULT_CONFIG.defaultTargetUrl
const DEFAULT_VERSION = DEFAULT_CONFIG.defaultVersion
const SERVER_CATALOG_AVAILABLE = DEFAULT_CONFIG.connectionProfileCatalogAvailable

type ProfileFormState = {
  name: string
  targetUrl: string
  version: WlsVersion
  username: string
}

function emptyProfileForm(): ProfileFormState {
  return {
    name: '',
    targetUrl: 'http://',
    version: DEFAULT_VERSION,
    username: 'weblogic',
  }
}

function profileForm(profile: ConnectionProfile): ProfileFormState {
  return {
    name: profile.name,
    targetUrl: profile.targetUrl,
    version: profile.version,
    username: profile.username ?? 'weblogic',
  }
}

function displayTarget(targetUrl: string) {
  const target = normalizeWlsTarget(targetUrl)
  if (!target.ok) return targetUrl
  return `${target.host}:${target.port}`
}

function lastUsedLabel(value: string | undefined) {
  if (!value) return 'Never used'
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return 'Used'
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function Login() {
  const { creds, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const allowConnectionManagement = location.pathname === '/connections'
  const [profiles, setProfiles] = useState<ConnectionProfile[]>(() =>
    seedDefaultConnectionProfile(DEFAULT_TARGET, DEFAULT_VERSION),
  )
  const [selectedProfileId, setSelectedProfileId] = useState(() => creds?.profileId ?? profiles[0]?.id ?? '')
  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId) ?? profiles[0] ?? null,
    [profiles, selectedProfileId],
  )
  const [username, setUsername] = useState(() => creds?.username ?? selectedProfile?.username ?? 'weblogic')
  const [password, setPassword] = useState('')
  const [version, setVersion] = useState<WlsVersion>(() => creds?.version ?? selectedProfile?.version ?? DEFAULT_VERSION)
  const [editingId, setEditingId] = useState<string | null>(() => (selectedProfile ? null : 'new'))
  const [profileDraft, setProfileDraft] = useState<ProfileFormState>(() =>
    selectedProfile ? profileForm(selectedProfile) : emptyProfileForm(),
  )
  const [message, setMessage] = useState<string | null>(() => readSignInNotice())
  useEffect(() => clearSignInNotice(), [])
  const [connecting, setConnecting] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  useEffect(() => {
    let cancelled = false
    void syncConnectionProfileCatalog(DEFAULT_TARGET, DEFAULT_VERSION, {
      serverCatalogAvailable: SERVER_CATALOG_AVAILABLE,
    }).then((next) => {
      if (cancelled) return
      setProfiles(next)
      setSelectedProfileId((current) => {
        const selectedId =
          (creds?.profileId && next.some((profile) => profile.id === creds.profileId) ? creds.profileId : '') ||
          (current && next.some((profile) => profile.id === current) ? current : '') ||
          next[0]?.id ||
          ''
        const selected = next.find((profile) => profile.id === selectedId) ?? null
        if (selected && !creds) {
          setUsername(selected.username ?? 'weblogic')
          setVersion(selected.version)
          setProfileDraft(profileForm(selected))
          setEditingId(null)
        } else if (!selected) {
          setProfileDraft(emptyProfileForm())
          setEditingId('new')
        }
        return selectedId
      })
    })
    return () => {
      cancelled = true
    }
  }, [creds])

  if (creds && !allowConnectionManagement) return <Navigate to="/dashboard" replace />

  const selectedIsActive = !!creds && selectedProfile?.id === creds.profileId

  async function refreshProfiles(nextSelectedId?: string) {
    const next = listConnectionProfiles()
    await persistConnectionProfileCatalog(next, { serverCatalogAvailable: SERVER_CATALOG_AVAILABLE })
    setProfiles(next)
    setSelectedProfileId(nextSelectedId ?? next[0]?.id ?? '')
  }

  function selectProfile(profile: ConnectionProfile) {
    setSelectedProfileId(profile.id)
    setUsername(profile.username ?? 'weblogic')
    setVersion(profile.version)
    setPassword('')
    setEditingId(null)
    setProfileDraft(profileForm(profile))
    setMessage(null)
  }

  function startCreateProfile() {
    setEditingId('new')
    setProfileDraft(emptyProfileForm())
    setMessage(null)
  }

  function startEditProfile(profile: ConnectionProfile) {
    setEditingId(profile.id)
    setProfileDraft(profileForm(profile))
    setMessage(null)
  }

  async function saveProfile(e: FormEvent) {
    e.preventDefault()
    const result =
      editingId === 'new'
        ? createConnectionProfile(profileDraft)
        : editingId
          ? updateConnectionProfile(editingId, profileDraft)
          : { ok: false as const, error: 'No profile is being edited.' }

    if (!result.ok) {
      setMessage(result.error)
      return
    }

    setEditingId(null)
    setMessage(null)
    await refreshProfiles(result.value.id)
    selectProfile(result.value)
  }

  async function removeSelectedProfile() {
    setConfirmingDelete(false)
    if (!selectedProfile || selectedProfile.id === creds?.profileId) return
    const next = deleteConnectionProfile(selectedProfile.id)
    await persistConnectionProfileCatalog(next, { serverCatalogAvailable: SERVER_CATALOG_AVAILABLE })
    setProfiles(next)
    const replacement = next[0] ?? null
    setSelectedProfileId(replacement?.id ?? '')
    if (replacement) {
      setUsername(replacement.username ?? 'weblogic')
      setVersion(replacement.version)
      setProfileDraft(profileForm(replacement))
      setEditingId(null)
    } else {
      setProfileDraft(emptyProfileForm())
      setEditingId('new')
    }
    setPassword('')
    setMessage(null)
  }

  async function onConnect(e: FormEvent) {
    e.preventDefault()
    if (!selectedProfile) {
      setMessage('Create or select a profile before connecting.')
      return
    }

    const connection = activeConnectionFromProfile({
      profile: selectedProfile,
      username,
      password,
      version,
    })
    if (!connection.ok) {
      setMessage(connection.error)
      return
    }

    setConnecting(true)
    setMessage(null)
    const check = await verifyWlsCredentials(connection.value)
    setConnecting(false)
    if (!check.ok) {
      setMessage(check.message)
      return
    }

    const nextProfiles = markConnectionProfileUsed(selectedProfile.id, username)
    await persistConnectionProfileCatalog(nextProfiles, { serverCatalogAvailable: SERVER_CATALOG_AVAILABLE })
    setProfiles(nextProfiles)
    login(connection.value)
    navigate('/dashboard')
  }

  return (
    <div className="min-h-svh bg-background p-6 text-foreground">
      <div className="mx-auto grid w-full max-w-5xl gap-4 lg:grid-cols-[minmax(260px,340px)_minmax(0,1fr)]">
        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>WLS Cockpit</CardTitle>
            <CardDescription>Domain connections</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button type="button" className="w-full justify-start" variant="outline" onClick={startCreateProfile}>
              <Plus className="size-4" strokeWidth={1.5} />
              Add domain
            </Button>

            <div className="space-y-2">
              {profiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  onClick={() => selectProfile(profile)}
                  className={cn(
                    'border-border bg-surface-1 hover:bg-accent/40 flex w-full min-w-0 items-start gap-3 rounded-md border px-3 py-2 text-left',
                    selectedProfile?.id === profile.id ? 'border-accent bg-accent/8' : null,
                  )}
                >
                  <span className="mt-0.5 flex size-5 items-center justify-center">
                    {selectedProfile?.id === profile.id ? <Check className="size-4" strokeWidth={1.5} /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium leading-[18px]">{profile.name}</span>
                    <MonoText className="block truncate text-[12px] text-muted-foreground">
                      {displayTarget(profile.targetUrl)} · v{profile.version}
                    </MonoText>
                    <span className="text-muted-foreground block truncate text-[12px] leading-4">
                      {lastUsedLabel(profile.lastUsedAt)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          {creds ? (
            <div
              className="border-border bg-surface-1 flex min-w-0 items-center justify-between gap-3 rounded-md border px-3 py-2 text-[13px]"
              data-current-connection
            >
              <span className="min-w-0">
                Connected to <span className="font-medium">{creds.name}</span> as{' '}
                <MonoText>{creds.username}</MonoText>. Connecting to another domain replaces this session.
              </span>
              <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => navigate('/dashboard')}>
                <ArrowLeft className="size-4" strokeWidth={1.5} />
                Back to {creds.name}
              </Button>
            </div>
          ) : null}

          {selectedProfile ? (
            <Card className="rounded-lg">
              <CardHeader>
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="truncate">{selectedProfile.name}</CardTitle>
                    <CardDescription>
                      <MonoText>{selectedProfile.targetUrl}</MonoText>
                    </CardDescription>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => startEditProfile(selectedProfile)}>
                      <Pencil className="size-4" strokeWidth={1.5} />
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setConfirmingDelete(true)}
                      disabled={selectedIsActive}
                      aria-label="Delete domain"
                      title={
                        selectedIsActive
                          ? 'You are connected to this domain. Sign out before deleting it.'
                          : 'Delete this saved domain'
                      }
                    >
                      <Trash2 className="size-4" strokeWidth={1.5} />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <form onSubmit={onConnect} className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="username">Username</Label>
                    <Input
                      id="username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      autoComplete="username"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password">Password</Label>
                    <Input
                      id="password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="version">WLS REST version</Label>
                    <select
                      id="version"
                      value={version}
                      onChange={(e) => setVersion(e.target.value as WlsVersion)}
                      className="border-input bg-background flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs"
                    >
                      {WLS_VERSIONS.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-end">
                    <Button type="submit" className="w-full" disabled={connecting}>
                      <PlugZap className="size-4" strokeWidth={1.5} />
                      {connecting ? 'Connecting…' : 'Connect'}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          ) : null}

          {editingId ? (
            <Card className="rounded-lg">
              <CardHeader>
                <CardTitle>{editingId === 'new' ? 'Add domain' : 'Edit domain'}</CardTitle>
                <CardDescription>Saved profile data excludes passwords.</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={saveProfile} className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="profile-name">Display name</Label>
                    <Input
                      id="profile-name"
                      value={profileDraft.name}
                      onChange={(e) => setProfileDraft((draft) => ({ ...draft, name: e.target.value }))}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="profile-target">AdminServer URL</Label>
                    <Input
                      id="profile-target"
                      value={profileDraft.targetUrl}
                      onChange={(e) => setProfileDraft((draft) => ({ ...draft, targetUrl: e.target.value }))}
                      placeholder="http://wls-admin.example.com:7001"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="profile-version">WLS REST version</Label>
                    <select
                      id="profile-version"
                      value={profileDraft.version}
                      onChange={(e) => setProfileDraft((draft) => ({ ...draft, version: e.target.value as WlsVersion }))}
                      className="border-input bg-background flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs"
                    >
                      {WLS_VERSIONS.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="profile-username">Default username</Label>
                    <Input
                      id="profile-username"
                      value={profileDraft.username}
                      onChange={(e) => setProfileDraft((draft) => ({ ...draft, username: e.target.value }))}
                      autoComplete="username"
                    />
                  </div>
                  <div className="flex items-end gap-2 sm:col-span-2">
                    <Button type="submit">{editingId === 'new' ? 'Add domain' : 'Save domain'}</Button>
                    <Button type="button" variant="ghost" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          ) : null}

          <ConfirmDialog
            open={confirmingDelete && !!selectedProfile}
            title="Delete saved domain?"
            description="This removes the connection profile from Cockpit's saved list. WebLogic is not affected, and you can add the domain again later."
            subject={selectedProfile ? `${selectedProfile.name} — ${selectedProfile.targetUrl}` : undefined}
            confirmLabel="Delete domain"
            onConfirm={() => void removeSelectedProfile()}
            onCancel={() => setConfirmingDelete(false)}
          />

          {message ? (
            <div className="border-status-negative/60 bg-status-negative/8 text-status-negative rounded-md border px-3 py-2 text-[13px]">
              {message}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
