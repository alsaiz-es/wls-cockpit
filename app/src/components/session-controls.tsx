import { ArrowLeftRight, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MonoText } from './mono-text'

// Two profiles can point at the same host:port (different users, or a renamed domain), so the
// profile name is the only reliable answer to "which domain am I acting on?".
export function ActiveDomainName({ name }: { name: string | undefined }) {
  const label = name?.trim()
  if (!label) return null
  return (
    <span
      className="max-w-48 min-w-0 truncate text-[13px] font-medium leading-[18px]"
      title={`Connected domain: ${label}`}
      data-active-domain
    >
      {label}
    </span>
  )
}

export interface SessionButtonsProps {
  domainName: string | undefined
  username: string | undefined
  onSwitch: () => void
  onSignOut: () => void
}

export function SessionButtons({ domainName, username, onSwitch, onSignOut }: SessionButtonsProps) {
  const domain = domainName?.trim() || 'this domain'
  return (
    <>
      <MonoText className="border-border-strong bg-surface-1 max-w-40 truncate border px-2 py-1 text-xs leading-[14px]">
        {username}
      </MonoText>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onSwitch}
        title={`Pick another saved domain. You stay connected to ${domain} until you connect to another one.`}
      >
        <ArrowLeftRight className="size-4" strokeWidth={1.5} />
        Switch domain
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onSignOut}
        title={`Forget the password for ${domain} in this tab and return to the sign-in page.`}
      >
        <LogOut className="size-4" strokeWidth={1.5} />
        Sign out
      </Button>
    </>
  )
}
