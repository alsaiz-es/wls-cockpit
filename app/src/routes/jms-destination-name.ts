// WebLogic names distributed-queue members 'module!jmsServer@member'; on an OSB domain every row
// starts with the same 'jmsResources!wlsbJMSServer_auto_2@dist_…', so a truncated full name hides
// the only part that differs. The distinguishing part is shown first.
export function jmsDestinationDisplayName(name: string) {
  const bang = name.indexOf('!')
  const module = bang > 0 ? name.slice(0, bang) : null
  const rest = bang > 0 ? name.slice(bang + 1) : name
  const at = rest.lastIndexOf('@')
  const primary = at >= 0 && at < rest.length - 1 ? rest.slice(at + 1) : rest
  const owner = at > 0 ? rest.slice(0, at) : null
  const secondary = [module, owner].filter(Boolean).join(' · ') || null
  return { primary, secondary }
}
