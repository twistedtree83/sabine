import { analyse } from './analyse'
import type { AnalysisRequest } from './types'

self.onmessage = (e: MessageEvent<AnalysisRequest>) => {
  try {
    const result = analyse(e.data)
    self.postMessage({ ok: true, result })
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
