import { useAssemblyStore, getDiffColor, getDiffLabel } from '../store/useAssemblyStore'

const MODEL_ICONS = {
  cpu: '[ ]',
  ram: '|||',
  motherboard: '[=]',
  gpu: '[G]',
  ssd: '[S]',
  psu: '[P]',
  cooler: '{~}',
  case: '[#]',
}

export default function AssemblyTree() {
  const assembly = useAssemblyStore((s) => s.assembly)
  const selectedComponentId = useAssemblyStore((s) => s.selectedComponentId)
  const hoveredComponentId = useAssemblyStore((s) => s.hoveredComponentId)
  const selectComponent = useAssemblyStore((s) => s.selectComponent)
  const setHoveredComponent = useAssemblyStore((s) => s.setHoveredComponent)
  const removeComponent = useAssemblyStore((s) => s.removeComponent)
  const diffResult = useAssemblyStore((s) => s.diffResult)
  const viewMode = useAssemblyStore((s) => s.viewMode)
  const diffSnapshots = useAssemblyStore((s) => s.diffSnapshots)

  // In diff mode, include removed components
  const removedComponents = viewMode === 'diff' && diffResult && diffSnapshots.before
    ? diffSnapshots.before.components.filter((c) => diffResult.removed.includes(c.id))
    : []

  const allComponents = [...assembly.components, ...removedComponents]

  return (
    <div className="flex-1 overflow-y-auto bg-[#12121f]">
      <div className="px-4 py-3 border-b border-gray-700/50">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Assembly Tree</h2>
      </div>

      {allComponents.length === 0 ? (
        <div className="px-4 py-8 text-center text-gray-600 text-xs">
          No components yet.
          <br />
          Drag from sidebar to add.
        </div>
      ) : (
        <div className="p-2 space-y-0.5">
          {/* Root node */}
          <div className="px-2 py-1.5 text-xs text-gray-400 flex items-center gap-2">
            <svg className="w-3 h-3 text-emerald-400" fill="currentColor" viewBox="0 0 20 20">
              <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
            </svg>
            <span className="font-medium text-gray-300">{assembly.name}</span>
            <span className="text-gray-600 ml-auto">{assembly.components.length}</span>
          </div>

          {/* Component nodes */}
          {allComponents.map((comp) => {
            const diffColor = getDiffColor(diffResult, comp.id)
            const diffLabel = getDiffLabel(diffResult, comp.id)
            const isSelected = selectedComponentId === comp.id
            const isHovered = hoveredComponentId === comp.id
            const isRemoved = diffResult?.removed.includes(comp.id)

            return (
              <div
                key={comp.id}
                onClick={() => !isRemoved && selectComponent(comp.id)}
                onMouseEnter={() => setHoveredComponent(comp.id)}
                onMouseLeave={() => setHoveredComponent(null)}
                className={`group ml-4 px-2 py-1.5 rounded text-xs flex items-center gap-2 cursor-pointer transition-all ${
                  isSelected
                    ? 'bg-emerald-500/20 border border-emerald-500/30'
                    : isHovered
                    ? 'bg-[#1a1a2e] border border-gray-600/30'
                    : 'border border-transparent'
                } ${isRemoved ? 'opacity-50 line-through' : ''}`}
                style={diffColor ? { borderLeftColor: diffColor, borderLeftWidth: 3 } : {}}
              >
                <span className="text-[10px] font-mono text-gray-600">{MODEL_ICONS[comp.model] || '<?>'}</span>
                <span className={`font-medium ${isSelected ? 'text-emerald-300' : 'text-gray-300'}`}>
                  {comp.name}
                </span>

                {diffLabel && viewMode === 'diff' && (
                  <span
                    className="ml-auto text-[9px] font-bold px-1.5 py-0.5 rounded"
                    style={{ color: diffColor, backgroundColor: `${diffColor}20` }}
                  >
                    {diffLabel}
                  </span>
                )}

                {!isDiffMode(viewMode) && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      removeComponent(comp.id)
                    }}
                    className="ml-auto text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                    title="Remove"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function isDiffMode(viewMode) {
  return viewMode === 'diff'
}
