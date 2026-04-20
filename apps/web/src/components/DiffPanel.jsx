import { useAssemblyStore, useWorkingConnectionDiff } from '../store/useAssemblyStore'

const DIFF_COLORS = {
  added: { bg: 'bg-green-500/10', border: 'border-green-500/30', text: 'text-green-400', label: 'Added' },
  modified: { bg: 'bg-yellow-500/10', border: 'border-yellow-500/30', text: 'text-yellow-400', label: 'Modified' },
  removed: { bg: 'bg-red-500/10', border: 'border-red-500/30', text: 'text-red-400', label: 'Removed' },
  moved: { bg: 'bg-blue-500/10', border: 'border-blue-500/30', text: 'text-blue-400', label: 'Repositioned' },
}

export default function DiffPanel() {
  const diffResult = useAssemblyStore((s) => s.diffResult)
  const diffSnapshots = useAssemblyStore((s) => s.diffSnapshots)
  const clearDiff = useAssemblyStore((s) => s.clearDiff)
  const connectionDiff = useWorkingConnectionDiff()

  if (!diffResult) return null

  const beforeComps = new Map(diffSnapshots.before?.components.map((c) => [c.id, c]) || [])
  const afterComps = new Map(diffSnapshots.after?.components.map((c) => [c.id, c]) || [])

  const totalChanges = diffResult.added.length + diffResult.modified.length +
    diffResult.removed.length + diffResult.moved.length
  const connectionChanges = (connectionDiff?.added?.length || 0) + (connectionDiff?.removed?.length || 0)

  return (
    <div className="absolute top-4 left-4 w-72 bg-[#12121f]/95 backdrop-blur-md border border-gray-700/50 rounded-xl shadow-2xl overflow-hidden z-10">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-700/50 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-200">Diff View</h3>
          <p className="text-[10px] text-gray-500 mt-0.5">
            {totalChanges} component change{totalChanges !== 1 ? 's' : ''} detected
            {connectionChanges > 0 ? ` · ${connectionChanges} connector change${connectionChanges !== 1 ? 's' : ''}` : ''}
          </p>
        </div>
        <button
          onClick={clearDiff}
          className="text-gray-500 hover:text-gray-200 transition-colors cursor-pointer"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Legend */}
      <div className="px-4 py-2 border-b border-gray-700/30 grid grid-cols-2 gap-1">
        {Object.entries(DIFF_COLORS).map(([key, val]) => {
          const count = diffResult[key === 'moved' ? 'moved' : key]?.length || 0
          return (
            <div key={key} className="flex items-center gap-1.5 text-[10px]">
              <div className={`w-2.5 h-2.5 rounded-sm ${val.text.replace('text-', 'bg-')}`} />
              <span className="text-gray-400">{val.label}</span>
              <span className={`${val.text} font-bold`}>{count}</span>
            </div>
          )
        })}
      </div>

      {/* Change details */}
      <div className="max-h-64 overflow-y-auto">
        {connectionChanges > 0 && (
          <div className="border-b border-gray-700/20">
            {connectionDiff.added.map((conn, i) => (
              <div key={`conn_add_${i}`} className="px-4 py-2 bg-green-500/10 border-l-2 border-green-500/30">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-gray-200">Connector {conn.type}</span>
                  <span className="text-[9px] font-bold text-green-400">ADDED</span>
                </div>
              </div>
            ))}
            {connectionDiff.removed.map((conn, i) => (
              <div key={`conn_rm_${i}`} className="px-4 py-2 bg-red-500/10 border-l-2 border-red-500/30">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-gray-200">Connector {conn.type}</span>
                  <span className="text-[9px] font-bold text-red-400">REMOVED</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {Object.entries(DIFF_COLORS).map(([key, style]) => {
          const ids = diffResult[key] || []
          if (ids.length === 0) return null

          return (
            <div key={key} className="border-b border-gray-700/20 last:border-0">
              {ids.map((id) => {
                const comp = afterComps.get(id) || beforeComps.get(id)
                if (!comp) return null

                const beforeComp = beforeComps.get(id)
                const afterComp = afterComps.get(id)

                return (
                  <div
                    key={id}
                    className={`px-4 py-2 ${style.bg} border-l-2 ${style.border}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-gray-200">{comp.name}</span>
                      <span className={`text-[9px] font-bold ${style.text}`}>{style.label.toUpperCase()}</span>
                    </div>

                    {/* Show position diff for moved */}
                    {key === 'moved' && beforeComp && afterComp && (
                      <div className="mt-1 text-[10px] text-gray-500 font-mono">
                        <span className="text-red-400/70">- pos({beforeComp.position.x.toFixed(1)}, {beforeComp.position.z.toFixed(1)})</span>
                        <br />
                        <span className="text-green-400/70">+ pos({afterComp.position.x.toFixed(1)}, {afterComp.position.z.toFixed(1)})</span>
                      </div>
                    )}

                    {/* Show metadata diff for modified */}
                    {key === 'modified' && beforeComp && afterComp && (
                      <div className="mt-1 text-[10px] text-gray-500 font-mono">
                        {beforeComp.name !== afterComp.name && (
                          <>
                            <span className="text-red-400/70">- {beforeComp.name}</span>
                            <br />
                            <span className="text-green-400/70">+ {afterComp.name}</span>
                          </>
                        )}
                        {JSON.stringify(beforeComp.metadata) !== JSON.stringify(afterComp.metadata) && (
                          <span className="text-yellow-400/70"> metadata changed</span>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}

        {totalChanges === 0 && (
          <div className="px-4 py-6 text-center text-gray-600 text-xs">
            No changes between snapshots
          </div>
        )}
      </div>
    </div>
  )
}
