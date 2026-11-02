export const SERVER_LIFECYCLE_FIELDS = 'name,state'
export const SERVER_RUNTIME_BASE_FIELDS =
  'name,state,healthState,listenAddress,listenPort,defaultURL'
export const JVM_RUNTIME_FIELDS =
  'heapFreeCurrent,heapSizeCurrent,heapSizeMax,uptime,javaVersion,javaVendor,javaVMVendor,OSName,OSVersion,processCpuLoad'
export const THREAD_POOL_FIELDS =
  'executeThreadTotalCount,executeThreadIdleCount,standbyThreadCount,pendingUserRequestCount,queueLength,hoggingThreadCount,stuckThreadCount'

export function serverLifecycleQueryParams() {
  return {
    fields: SERVER_LIFECYCLE_FIELDS,
    links: 'none',
  }
}

export function serverRuntimeBaseQueryParams() {
  return {
    fields: SERVER_RUNTIME_BASE_FIELDS,
    links: 'none',
  }
}

export function jvmHeapQueryParams() {
  return {
    fields: JVM_RUNTIME_FIELDS,
    links: 'none',
  }
}

export function threadPoolQueryParams() {
  return {
    fields: THREAD_POOL_FIELDS,
    links: 'none',
  }
}
