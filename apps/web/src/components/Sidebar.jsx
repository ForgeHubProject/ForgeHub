import { useState, useMemo } from 'react'
import { useAssemblyStore } from '../store/useAssemblyStore'
import { searchComponents } from '../domain/componentRegistry'

const CATEGORY_COLORS = {
  Processing: 'text-orange-400',
  Memory:     'text-cyan-400',
  Board:      'text-emerald-400',
  Graphics:   'text-violet-400',
  Storage:    'text-pink-400',
  Power:      'text-red-400',
  Cooling:    'text-sky-400',
  Enclosure:  'text-gray-400',
}

const CATEGORY_ICONS = {
  Processing: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
      <rect x="9" y="9" width="6" height="6" rx="0.75" fill="currentColor" opacity="0.25" />
      <line x1="4" y1="9" x2="6" y2="9" /><line x1="4" y1="12" x2="6" y2="12" /><line x1="4" y1="15" x2="6" y2="15" />
      <line x1="18" y1="9" x2="20" y2="9" /><line x1="18" y1="12" x2="20" y2="12" /><line x1="18" y1="15" x2="20" y2="15" />
      <line x1="9" y1="4" x2="9" y2="6" /><line x1="12" y1="4" x2="12" y2="6" /><line x1="15" y1="4" x2="15" y2="6" />
      <line x1="9" y1="18" x2="9" y2="20" /><line x1="12" y1="18" x2="12" y2="20" /><line x1="15" y1="18" x2="15" y2="20" />
    </svg>
  ),
  Memory: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="7" width="18" height="10" rx="1" />
      <rect x="5.5" y="9.5" width="3" height="5" rx="0.5" fill="currentColor" opacity="0.2" />
      <rect x="10" y="9.5" width="3" height="5" rx="0.5" fill="currentColor" opacity="0.2" />
      <rect x="14.5" y="9.5" width="3" height="5" rx="0.5" fill="currentColor" opacity="0.2" />
    </svg>
  ),
  Board: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="3" width="18" height="18" rx="1.5" />
      <rect x="6" y="6" width="6" height="6" rx="0.75" stroke="currentColor" strokeWidth="1" opacity="0.5" />
      <rect x="15" y="6" width="4" height="2.5" rx="0.5" fill="currentColor" opacity="0.2" />
      <rect x="15" y="10" width="4" height="2.5" rx="0.5" fill="currentColor" opacity="0.2" />
      <line x1="6" y1="15" x2="18" y2="15" strokeWidth="0.75" opacity="0.3" />
      <line x1="6" y1="18" x2="18" y2="18" strokeWidth="0.75" opacity="0.3" />
    </svg>
  ),
  Graphics: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="7" width="20" height="10" rx="1.5" />
      <circle cx="8" cy="12" r="3" strokeWidth="1" opacity="0.5" />
      <circle cx="16" cy="12" r="3" strokeWidth="1" opacity="0.5" />
      <line x1="2" y1="18" x2="4" y2="18" /><line x1="6" y1="18" x2="8" y2="18" />
    </svg>
  ),
  Storage: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="9" width="18" height="6" rx="1" />
      <rect x="6" y="11" width="5" height="2" rx="0.5" fill="currentColor" opacity="0.2" />
      <rect x="13" y="11" width="3" height="2" rx="0.5" fill="currentColor" opacity="0.2" />
    </svg>
  ),
  Power: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="4" y="5" width="16" height="14" rx="1.5" />
      <circle cx="12" cy="12" r="4" strokeWidth="1" opacity="0.4" />
      <path d="M13 3v2M11 19v2" strokeWidth="1" />
    </svg>
  ),
  Cooling: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="2.5" fill="currentColor" opacity="0.2" />
      <path d="M12 4v3M12 17v3M4 12h3M17 12h3M6.3 6.3l2.1 2.1M15.6 15.6l2.1 2.1M6.3 17.7l2.1-2.1M15.6 8.4l2.1-2.1" strokeWidth="1" />
    </svg>
  ),
  Enclosure: (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="4" y="2" width="16" height="20" rx="1.5" />
      <circle cx="12" cy="8" r="3" strokeWidth="1" opacity="0.4" />
      <line x1="8" y1="14" x2="16" y2="14" strokeWidth="0.75" opacity="0.3" />
      <line x1="8" y1="16.5" x2="16" y2="16.5" strokeWidth="0.75" opacity="0.3" />
    </svg>
  ),
}

export default function Sidebar() {
  const [query, setQuery] = useState('')
  const previewingType = useAssemblyStore((s) => s.previewingType)
  const setPreviewingType = useAssemblyStore((s) => s.setPreviewingType)

  const results = useMemo(() => searchComponents(query), [query])

  const grouped = useMemo(() => {
    const map = new Map()
    for (const d of results) {
      if (!map.has(d.category)) map.set(d.category, [])
      map.get(d.category).push(d)
    }
    return map
  }, [results])

  const handleDragStart = (e, type) => {
    e.dataTransfer.setData('component-type', type)
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div className="w-64 bg-[#12121f] border-r border-gray-700/50 flex flex-col shrink-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-700/50">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
          Component Registry
        </h2>
        <div className="relative">
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500"
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search modules..."
            className="w-full bg-[#1a1a2e] text-sm text-gray-200 placeholder-gray-600 border border-gray-700/50 focus:border-emerald-500/60 rounded-lg pl-8 pr-3 py-1.5 outline-none transition-colors"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 cursor-pointer"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Catalog */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {results.length === 0 && (
          <div className="text-center text-gray-600 text-xs py-8">
            No modules match &ldquo;{query}&rdquo;
          </div>
        )}

        {[...grouped.entries()].map(([category, items]) => (
          <div key={category}>
            <div className={`text-[10px] font-semibold uppercase tracking-wider mb-1.5 ${CATEGORY_COLORS[category] || 'text-gray-500'}`}>
              {category}
            </div>
            <div className="space-y-1.5">
              {items.map((desc) => {
                const isPreviewing = previewingType === desc.type
                return (
                  <div
                    key={desc.type}
                    draggable
                    onDragStart={(e) => handleDragStart(e, desc.type)}
                    onClick={() => setPreviewingType(isPreviewing ? null : desc.type)}
                    className={`group flex items-start gap-2.5 p-2.5 rounded-lg cursor-grab active:cursor-grabbing transition-all border ${
                      isPreviewing
                        ? 'bg-emerald-500/10 border-emerald-500/30'
                        : 'bg-[#1a1a2e] hover:bg-[#22223a] border-transparent hover:border-gray-600/40'
                    }`}
                  >
                    <div className={`mt-0.5 shrink-0 ${CATEGORY_COLORS[desc.category] || 'text-gray-400'}`}>
                      {CATEGORY_ICONS[desc.category] || CATEGORY_ICONS.Processing}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-gray-200 group-hover:text-white truncate">
                        {desc.name}
                      </div>
                      <div className="text-[10px] text-gray-500 leading-tight mt-0.5 line-clamp-2">
                        {desc.description}
                      </div>
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {desc.tags.slice(0, 3).map((tag) => (
                          <span key={tag} className="text-[9px] bg-gray-700/40 text-gray-400 px-1.5 py-0.5 rounded">
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Footer hint */}
      <div className="p-3 border-t border-gray-700/50">
        <p className="text-[10px] text-gray-600 text-center">
          Drag to canvas to add &middot; Click to inspect
        </p>
      </div>
    </div>
  )
}
