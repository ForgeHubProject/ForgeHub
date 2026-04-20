import { useState } from 'react'
import { useAssemblyStore } from '../store/useAssemblyStore'

export default function SnapshotPanel() {
  const snapshots = useAssemblyStore((s) => s.snapshots)
  const loadSnapshot = useAssemblyStore((s) => s.loadSnapshot)
  const deleteSnapshot = useAssemblyStore((s) => s.deleteSnapshot)
  const computeDiff = useAssemblyStore((s) => s.computeDiff)
  const [compareMode, setCompareMode] = useState(false)
  const [selectedPair, setSelectedPair] = useState([null, null])

  const handleCompare = () => {
    if (selectedPair[0] && selectedPair[1]) {
      computeDiff(selectedPair[0], selectedPair[1])
      setCompareMode(false)
      setSelectedPair([null, null])
    }
  }

  const handleSelect = (id) => {
    if (!compareMode) return
    setSelectedPair((prev) => {
      if (!prev[0]) return [id, null]
      if (!prev[1] && id !== prev[0]) return [prev[0], id]
      return [id, null]
    })
  }

  const formatTime = (ts) => {
    const d = new Date(ts)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="h-64 border-t border-gray-700/50 bg-[#12121f] flex flex-col shrink-0">
      <div className="px-4 py-3 border-b border-gray-700/50 flex items-center justify-between">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Snapshots</h2>
        <div className="flex gap-1">
          {compareMode ? (
            <>
              <button
                onClick={handleCompare}
                disabled={!selectedPair[0] || !selectedPair[1]}
                className="text-[10px] bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white px-2 py-1 rounded transition-colors cursor-pointer"
              >
                Compare
              </button>
              <button
                onClick={() => { setCompareMode(false); setSelectedPair([null, null]) }}
                className="text-[10px] text-gray-400 hover:text-gray-200 px-2 py-1 cursor-pointer"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setCompareMode(true)}
              disabled={snapshots.length < 2}
              className="text-[10px] bg-blue-600/80 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white px-2 py-1 rounded transition-colors cursor-pointer"
            >
              Diff
            </button>
          )}
        </div>
      </div>

      {compareMode && (
        <div className="px-4 py-1.5 bg-blue-900/20 border-b border-blue-800/30 text-[10px] text-blue-400">
          Select two snapshots to compare
          {selectedPair[0] && !selectedPair[1] && ' — now pick the second'}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {snapshots.length === 0 ? (
          <div className="text-center text-gray-600 text-xs py-6">
            No snapshots yet.
            <br />
            Click Commit to save.
          </div>
        ) : (
          [...snapshots].reverse().map((snap) => {
            const isBeforeSelected = selectedPair[0] === snap.id
            const isAfterSelected = selectedPair[1] === snap.id
            return (
              <div
                key={snap.id}
                onClick={() => compareMode ? handleSelect(snap.id) : loadSnapshot(snap.id)}
                className={`px-3 py-2 rounded text-xs cursor-pointer transition-all border ${
                  isBeforeSelected
                    ? 'bg-red-500/15 border-red-500/40'
                    : isAfterSelected
                    ? 'bg-green-500/15 border-green-500/40'
                    : 'bg-[#1a1a2e] border-transparent hover:border-gray-600/30 hover:bg-[#22223a]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-gray-200 truncate">{snap.message}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    {isBeforeSelected && <span className="text-[9px] text-red-400 font-bold">BEFORE</span>}
                    {isAfterSelected && <span className="text-[9px] text-green-400 font-bold">AFTER</span>}
                    {!compareMode && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          deleteSnapshot(snap.id)
                        }}
                        className="text-gray-600 hover:text-red-400 cursor-pointer"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
                <div className="text-gray-600 mt-0.5">
                  {formatTime(snap.timestamp)} · {snap.assembly.components.length} components
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
