import { useCallback, useEffect, useState, startTransition } from 'react'
import {
  compareSnapshots,
  getApiBaseUrl,
  getHealth,
  listProjectSnapshots,
} from '../api/forgehubApi'
import {
  DEFAULT_API_BASE_SNAPSHOT_ID,
  DEFAULT_API_PROJECT_ID,
  DEFAULT_API_TARGET_SNAPSHOT_ID,
} from '../api/defaults'

export default function BackendApiPanel() {
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState(null)
  const [serverSnapshots, setServerSnapshots] = useState(null)
  const [compareResult, setCompareResult] = useState(null)
  const [compareLoading, setCompareLoading] = useState(false)
  const [compareError, setCompareError] = useState(null)

  const probe = useCallback(async () => {
    setStatus('checking')
    setError(null)
    setCompareError(null)
    setServerSnapshots(null)
    try {
      await getHealth()
      const snapRes = await listProjectSnapshots(DEFAULT_API_PROJECT_ID)
      setServerSnapshots(snapRes)
      setStatus('ok')
    } catch (e) {
      setStatus('offline')
      setError(e?.message || String(e))
    }
  }, [])

  useEffect(() => {
    startTransition(() => {
      void probe()
    })
  }, [probe])

  const runSeedCompare = async () => {
    setCompareLoading(true)
    setCompareResult(null)
    setCompareError(null)
    try {
      const res = await compareSnapshots({
        projectId: DEFAULT_API_PROJECT_ID,
        baseSnapshotId: DEFAULT_API_BASE_SNAPSHOT_ID,
        targetSnapshotId: DEFAULT_API_TARGET_SNAPSHOT_ID,
        options: { includeRawJsonDiff: false, includeIgnoredStats: true },
      })
      setCompareResult(res)
    } catch (e) {
      setCompareError(e?.message || String(e))
    } finally {
      setCompareLoading(false)
    }
  }

  return (
    <div className="shrink-0 border-t border-gray-700/50 bg-[#12121f] flex flex-col max-h-[14rem]">
      <div className="px-4 py-2 border-b border-gray-700/50 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Canonical API</h2>
        <button
          type="button"
          onClick={probe}
          className="text-[10px] text-gray-500 hover:text-gray-300 cursor-pointer"
        >
          Refresh
        </button>
      </div>

      <div className="px-3 py-2 space-y-2 text-[10px] overflow-y-auto">
        <div className="text-gray-600 font-mono truncate" title={getApiBaseUrl()}>
          {getApiBaseUrl()}
        </div>

        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              status === 'ok' ? 'bg-emerald-500' : status === 'checking' ? 'bg-amber-400 animate-pulse' : 'bg-red-500'
            }`}
          />
          <span className="text-gray-400">
            {status === 'checking' && 'Checking API…'}
            {status === 'ok' && 'API reachable'}
            {status === 'offline' && 'API unreachable'}
            {status === 'idle' && 'Idle'}
          </span>
        </div>

        {error && status === 'offline' && (
          <p className="text-red-400/90 leading-snug">{error}</p>
        )}

        {compareError && (
          <p className="text-red-400/90 leading-snug">{compareError}</p>
        )}

        {serverSnapshots && (
          <div className="text-gray-500">
            <span className="text-gray-400">{serverSnapshots.projectName}</span>
            {' · '}
            {serverSnapshots.snapshots?.length ?? 0} server snapshot
            {(serverSnapshots.snapshots?.length ?? 0) !== 1 ? 's' : ''}
          </div>
        )}

        <button
          type="button"
          disabled={status !== 'ok' || compareLoading}
          onClick={runSeedCompare}
          className="w-full text-[10px] bg-violet-600/80 hover:bg-violet-500 disabled:bg-gray-700 disabled:text-gray-500 text-white px-2 py-1.5 rounded transition-colors cursor-pointer"
        >
          {compareLoading ? 'Comparing…' : 'Compare seed snapshots (API)'}
        </button>

        {compareResult && (
          <div className="rounded border border-gray-700/40 bg-[#1a1a2e] p-2 space-y-1">
            <div className="text-gray-400 flex flex-wrap gap-x-2 gap-y-0.5">
              <span className="text-emerald-400">+{compareResult.summary?.added ?? 0}</span>
              <span className="text-red-400">−{compareResult.summary?.removed ?? 0}</span>
              <span className="text-yellow-400">~{compareResult.summary?.modified ?? 0}</span>
              <span className="text-blue-400">↔{compareResult.summary?.moved ?? 0}</span>
            </div>
            <ul className="max-h-16 overflow-y-auto text-gray-500 space-y-0.5 font-mono leading-tight">
              {(compareResult.changes || []).slice(0, 12).map((ch) => (
                <li key={ch.changeId}>
                  <span className="text-gray-400">{ch.type}</span> {ch.path}
                </li>
              ))}
            </ul>
            {(compareResult.changes || []).length > 12 && (
              <div className="text-gray-600">…{compareResult.changes.length - 12} more</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
