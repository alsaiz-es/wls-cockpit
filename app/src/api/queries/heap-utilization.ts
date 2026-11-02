export interface HeapUsage {
  current: number
  max: number
  committed?: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function normalizeHeapUsage(value: unknown): HeapUsage | null {
  if (!isObject(value)) return null

  const heapFreeCurrent = readNumber(value.heapFreeCurrent)
  const heapSizeCurrent = readNumber(value.heapSizeCurrent)
  const heapSizeMax = readNumber(value.heapSizeMax)
  if (heapFreeCurrent === null || heapSizeCurrent === null || heapSizeMax === null || heapSizeMax <= 0) {
    return null
  }

  return {
    current: Math.max(0, heapSizeCurrent - heapFreeCurrent),
    committed: Math.max(0, heapSizeCurrent),
    max: heapSizeMax,
  }
}

export function heapUtilization(heap: HeapUsage | null | undefined): number | null {
  if (!heap || heap.max <= 0) return null
  return Math.min(1, Math.max(0, heap.current / heap.max))
}

export function heapUtilizationLabel(heap: HeapUsage | null | undefined) {
  const utilization = heapUtilization(heap)
  if (utilization === null) return '-'

  const percent = utilization * 100
  return percent >= 99 && percent < 100 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`
}

export type HeapTone = 'positive' | 'warning' | 'negative' | 'neutral'

export function heapToneForPercent(percent: number | null | undefined): HeapTone {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return 'neutral'
  if (percent >= 85) return 'negative'
  if (percent >= 70) return 'warning'
  return 'positive'
}

export function heapTone(heap: HeapUsage | null | undefined): HeapTone {
  const utilization = heapUtilization(heap)
  return utilization === null ? 'neutral' : heapToneForPercent(utilization * 100)
}

export interface HeapSegments {
  used: number
  committed: number
  max: number
  usedPercent: number
  committedPercent: number
  committedUnusedPercent: number
  emptyPercent: number
  tone: HeapTone
}

export function heapSegments(heap: HeapUsage | null | undefined): HeapSegments | null {
  if (!heap || heap.max <= 0) return null

  const max = heap.max
  const used = clamp(heap.current, 0, max)
  const committed = clamp(heap.committed ?? heap.current, used, max)
  const usedPercent = (used / max) * 100
  const committedPercent = (committed / max) * 100

  return {
    used,
    committed,
    max,
    usedPercent,
    committedPercent,
    committedUnusedPercent: committedPercent - usedPercent,
    emptyPercent: 100 - committedPercent,
    tone: heapToneForPercent(usedPercent),
  }
}
