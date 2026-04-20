import { useAssemblyStore } from '../store/useAssemblyStore'
import { getDescriptor, compatibleParents, compatibleChildren } from '../domain/componentRegistry'

function SpecRow({ label, value }) {
  return (
    <div className="flex justify-between py-1 border-b border-gray-700/20 last:border-0">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-200 font-medium text-right">{value}</span>
    </div>
  )
}

function Badge({ children, color = 'gray' }) {
  const colors = {
    gray:    'bg-gray-700/40 text-gray-400',
    emerald: 'bg-emerald-500/15 text-emerald-400',
    blue:    'bg-blue-500/15 text-blue-400',
    orange:  'bg-orange-500/15 text-orange-400',
    violet:  'bg-violet-500/15 text-violet-400',
  }
  return (
    <span className={`text-[9px] px-1.5 py-0.5 rounded ${colors[color] || colors.gray}`}>
      {children}
    </span>
  )
}

function CatalogPreview({ type }) {
  const desc = getDescriptor(type)
  if (!desc) return null

  const parents = compatibleParents(type)
  const children = compatibleChildren(type)

  return (
    <div className="space-y-3">
      {/* Header */}
      <div>
        <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">
          {desc.category}
        </div>
        <h3 className="text-sm font-semibold text-gray-100">{desc.name}</h3>
        <p className="text-[11px] text-gray-400 leading-relaxed mt-1">{desc.description}</p>
      </div>

      {/* Specs */}
      <div>
        <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">
          Specifications
        </div>
        <div className="text-[11px]">
          {Object.entries(desc.specs).map(([key, val]) => (
            <SpecRow key={key} label={formatKey(key)} value={String(val)} />
          ))}
        </div>
      </div>

      {/* Mount points */}
      {desc.mountPoints.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">
            Provides slots
          </div>
          <div className="flex flex-wrap gap-1">
            {desc.mountPoints.map((mp) => (
              <Badge key={mp.id} color="emerald">{mp.label}</Badge>
            ))}
          </div>
        </div>
      )}

      {/* Fits into */}
      {desc.fitsInSlots.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">
            Fits into
          </div>
          <div className="flex flex-wrap gap-1">
            {desc.fitsInSlots.map((s) => (
              <Badge key={s} color="blue">{formatKey(s)}</Badge>
            ))}
          </div>
        </div>
      )}

      {/* Compatibility */}
      {parents.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">
            Can attach to
          </div>
          <div className="flex flex-wrap gap-1">
            {parents.map((p) => (
              <Badge key={p.type} color="orange">{p.name}</Badge>
            ))}
          </div>
        </div>
      )}

      {children.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">
            Accepts
          </div>
          <div className="flex flex-wrap gap-1">
            {children.map((c) => (
              <Badge key={c.type} color="violet">{c.name}</Badge>
            ))}
          </div>
        </div>
      )}

      {/* Tags */}
      <div>
        <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">
          Tags
        </div>
        <div className="flex flex-wrap gap-1">
          {desc.tags.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
        </div>
      </div>
    </div>
  )
}

function InstanceProperties({ componentId }) {
  const allComponents = useAssemblyStore((s) => s.assembly.components)
  const allConnections = useAssemblyStore((s) => s.assembly.connections)

  const component = allComponents.find((c) => c.id === componentId)
  const connections = allConnections.filter(
    (conn) => conn.from === componentId || conn.to === componentId,
  )

  if (!component) return null

  const desc = getDescriptor(component.model)
  const children = compatibleChildren(component.model)

  return (
    <div className="space-y-3">
      {/* Header */}
      <div>
        {desc && (
          <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">
            {desc.category}
          </div>
        )}
        <h3 className="text-sm font-semibold text-gray-100">{component.name}</h3>
        <div className="text-[10px] text-gray-600 font-mono mt-0.5">{component.id}</div>
      </div>

      {/* Position / Rotation */}
      <div>
        <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">
          Transform
        </div>
        <div className="text-[11px]">
          <SpecRow
            label="Position"
            value={`${component.position.x.toFixed(2)}, ${component.position.y.toFixed(2)}, ${component.position.z.toFixed(2)}`}
          />
          <SpecRow
            label="Rotation"
            value={`${component.rotation.x.toFixed(1)}, ${component.rotation.y.toFixed(1)}, ${component.rotation.z.toFixed(1)}`}
          />
        </div>
      </div>

      {/* Metadata / specs */}
      {component.metadata && Object.keys(component.metadata).length > 0 && (
        <div>
          <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">
            Specifications
          </div>
          <div className="text-[11px]">
            {Object.entries(component.metadata).map(([key, val]) => (
              <SpecRow key={key} label={formatKey(key)} value={String(val)} />
            ))}
          </div>
        </div>
      )}

      {/* Connections */}
      {connections.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">
            Connections ({connections.length})
          </div>
          <div className="space-y-1">
            {connections.map((conn, i) => {
              const otherId = conn.from === componentId ? conn.to : conn.from
              const other = allComponents.find((c) => c.id === otherId)
              const direction = conn.from === componentId ? '→' : '←'
              return (
                <div key={i} className="text-[11px] flex items-center gap-1.5 text-gray-400">
                  <span className="text-gray-600">{direction}</span>
                  <span className="text-gray-300">{other?.name || otherId}</span>
                  <Badge>{conn.type}</Badge>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Compatible children */}
      {children.length > 0 && desc && (
        <div>
          <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">
            Accepts
          </div>
          <div className="flex flex-wrap gap-1">
            {children.map((c) => (
              <Badge key={c.type} color="violet">{c.name}</Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function formatKey(key) {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase())
}

export default function ComponentProperties() {
  const previewingType = useAssemblyStore((s) => s.previewingType)
  const selectedComponentId = useAssemblyStore((s) => s.selectedComponentId)
  const clearPreview = useAssemblyStore((s) => s.clearPreview)

  const hasContent = previewingType || selectedComponentId

  if (!hasContent) {
    return (
      <div className="flex-1 bg-[#12121f] border-t border-gray-700/50 flex flex-col">
        <div className="px-4 py-3 border-b border-gray-700/50">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Inspector</h2>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-[11px] text-gray-600 text-center leading-relaxed">
            Click a module in the registry to preview its specs, or select a placed component to inspect it.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 bg-[#12121f] border-t border-gray-700/50 flex flex-col min-h-0">
      <div className="px-4 py-3 border-b border-gray-700/50 flex items-center justify-between">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          {previewingType ? 'Module Preview' : 'Properties'}
        </h2>
        {previewingType && (
          <button
            onClick={clearPreview}
            className="text-gray-500 hover:text-gray-300 cursor-pointer"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {previewingType ? (
          <CatalogPreview type={previewingType} />
        ) : (
          <InstanceProperties componentId={selectedComponentId} />
        )}
      </div>
    </div>
  )
}
