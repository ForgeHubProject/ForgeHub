import { useState } from 'react'
import { useAssemblyStore } from '../store/useAssemblyStore'

export default function Toolbar() {
  const [commitMsg, setCommitMsg] = useState('')
  const [showCommit, setShowCommit] = useState(false)
  const assemblyName = useAssemblyStore((s) => s.assembly.name)
  const setAssemblyName = useAssemblyStore((s) => s.setAssemblyName)
  const commitSnapshot = useAssemblyStore((s) => s.commitSnapshot)
  const componentCount = useAssemblyStore((s) => s.assembly.components.length)
  const viewMode = useAssemblyStore((s) => s.viewMode)
  const clearDiff = useAssemblyStore((s) => s.clearDiff)

  const handleCommit = () => {
    if (!commitMsg.trim()) return
    commitSnapshot(commitMsg.trim())
    setCommitMsg('')
    setShowCommit(false)
  }

  return (
    <div className="h-12 bg-[#12121f] border-b border-gray-700/50 flex items-center px-4 gap-4 shrink-0">
      {/* Logo */}
      <div className="flex items-center gap-2">
        <svg className="w-6 h-6 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
        </svg>
        <span className="font-bold text-sm tracking-wide text-emerald-400">ForgeHub</span>
      </div>

      {/* Separator */}
      <div className="w-px h-6 bg-gray-700/50" />

      {/* Assembly name */}
      <input
        className="bg-transparent text-sm font-medium text-gray-200 border border-transparent hover:border-gray-600 focus:border-emerald-500 rounded px-2 py-1 outline-none transition-colors w-48"
        value={assemblyName}
        onChange={(e) => setAssemblyName(e.target.value)}
      />

      {/* Component count */}
      <span className="text-xs text-gray-500">{componentCount} component{componentCount !== 1 ? 's' : ''}</span>

      <div className="flex-1" />

      {/* Diff mode indicator */}
      {viewMode === 'diff' && (
        <button
          onClick={clearDiff}
          className="text-xs bg-blue-500/20 text-blue-400 border border-blue-500/30 px-3 py-1 rounded hover:bg-blue-500/30 transition-colors cursor-pointer"
        >
          Exit Diff View
        </button>
      )}

      {/* Commit button */}
      {showCommit ? (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            className="bg-[#1a1a2e] text-sm text-gray-200 border border-gray-600 focus:border-emerald-500 rounded px-2 py-1 outline-none w-56"
            placeholder="Commit message..."
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCommit()}
          />
          <button
            onClick={handleCommit}
            className="text-xs bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded transition-colors cursor-pointer"
          >
            Commit
          </button>
          <button
            onClick={() => setShowCommit(false)}
            className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1.5 cursor-pointer"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setShowCommit(true)}
          className="text-xs bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded transition-colors flex items-center gap-1.5 cursor-pointer"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          Commit
        </button>
      )}
    </div>
  )
}
