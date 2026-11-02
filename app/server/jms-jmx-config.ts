import { existsSync } from 'node:fs'
import path from 'node:path'

export interface JmsJmxConfig {
  available: boolean
  javaCommand: string
  javacCommand: string
  classpath: string | null
  reason: string | null
}

function clean(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function classpathFromExplicit(value: string | undefined) {
  const explicit = clean(value)
  if (!explicit) return null
  return explicit
}

function classpathFromWlHome(value: string | undefined) {
  const wlHome = clean(value)
  if (!wlHome) return null

  const serverLib = path.resolve(wlHome, 'server', 'lib')
  const thinT3Client = path.join(serverLib, 'wlthint3client.jar')
  if (existsSync(thinT3Client)) return thinT3Client

  return null
}

function classpathFromOracleHome(value: string | undefined) {
  const oracleHome = clean(value)
  if (!oracleHome) return null

  const candidates = [
    path.resolve(oracleHome, 'wlserver', 'server', 'lib', 'wlthint3client.jar'),
    path.resolve(oracleHome, 'server', 'lib', 'wlthint3client.jar'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export function discoverJmsJmxConfig(env: Record<string, string | undefined> = process.env): JmsJmxConfig {
  const explicit = classpathFromExplicit(env.WLS_COCKPIT_WLS_CLIENT_CLASSPATH)
  const fromWlsCockpitWlHome = explicit ? null : classpathFromWlHome(env.WLS_COCKPIT_WL_HOME)
  const fromWlHome = explicit || fromWlsCockpitWlHome ? null : classpathFromWlHome(env.WL_HOME)
  const fromOracleHome = explicit || fromWlsCockpitWlHome || fromWlHome ? null : classpathFromOracleHome(env.ORACLE_HOME)
  const classpath = explicit ?? fromWlsCockpitWlHome ?? fromWlHome ?? fromOracleHome

  return {
    available: classpath !== null,
    javaCommand: clean(env.WLS_COCKPIT_JAVA_COMMAND) ?? 'java',
    javacCommand: clean(env.WLS_COCKPIT_JAVAC_COMMAND) ?? 'javac',
    classpath,
    reason: classpath
      ? null
      : 'JMS message browsing requires WLS_COCKPIT_WLS_CLIENT_CLASSPATH, WLS_COCKPIT_WL_HOME, WL_HOME, or ORACLE_HOME with a local wlthint3client.jar on the Cockpit host.',
  }
}
