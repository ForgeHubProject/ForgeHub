import { create } from 'zustand'
import { useMemo } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { getDescriptor } from '../domain/componentRegistry'

const SNAPSHOTS_KEY = 'forgehub_snapshots'

function loadSnapshots() {
  try {
    const data = localStorage.getItem(SNAPSHOTS_KEY)
    return data ? JSON.parse(data) : []
  } catch {
    return []
  }
}

function saveSnapshots(snapshots) {
  localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(snapshots))
}

export const useAssemblyStore = create((set, get) => ({
  // Assembly state
  assembly: {
    id: uuidv4(),
    name: 'New Assembly',
    components: [],
    connections: [],
  },

  // UI state
  selectedComponentId: null,
  hoveredComponentId: null,
  previewingType: null,
  draggingInfo: null,        // { componentId, componentType } while a component is being dragged
  highlightedMountPoint: null, // { componentId, mountPointId } — the snap target
  snapshots: loadSnapshots(),
  diffResult: null,
  diffSnapshots: { before: null, after: null },
  viewMode: 'build', // 'build' | 'diff'

  // Actions
  setAssemblyName: (name) =>
    set((state) => ({ assembly: { ...state.assembly, name } })),

  addComponent: (type, position = { x: 0, y: 0.5, z: 0 }) => {
    const descriptor = getDescriptor(type)
    if (!descriptor) return

    const component = {
      id: `comp_${uuidv4().slice(0, 8)}`,
      name: descriptor.name,
      model: descriptor.model,
      position: { ...position },
      rotation: { x: 0, y: 0, z: 0 },
      metadata: { ...descriptor.specs },
      children: [],
    }

    set((state) => ({
      assembly: {
        ...state.assembly,
        components: [...state.assembly.components, component],
      },
      selectedComponentId: component.id,
    }))

    return component.id
  },

  removeComponent: (id) =>
    set((state) => ({
      assembly: {
        ...state.assembly,
        components: state.assembly.components.filter((c) => c.id !== id),
        connections: state.assembly.connections.filter(
          (conn) => conn.from !== id && conn.to !== id
        ),
      },
      selectedComponentId:
        state.selectedComponentId === id ? null : state.selectedComponentId,
    })),

  updateComponentPosition: (id, position) =>
    set((state) => ({
      assembly: {
        ...state.assembly,
        components: state.assembly.components.map((c) =>
          c.id === id ? { ...c, position: { ...position } } : c
        ),
      },
    })),

  updateComponentRotation: (id, rotation) =>
    set((state) => ({
      assembly: {
        ...state.assembly,
        components: state.assembly.components.map((c) =>
          c.id === id ? { ...c, rotation: { ...rotation } } : c
        ),
      },
    })),

  selectComponent: (id) => set({ selectedComponentId: id, previewingType: null }),

  setHoveredComponent: (id) => set({ hoveredComponentId: id }),

  setPreviewingType: (type) => set({ previewingType: type, selectedComponentId: null }),
  clearPreview: () => set({ previewingType: null }),

  setDraggingInfo: (info) => set({ draggingInfo: info }),
  clearDraggingInfo: () => set({ draggingInfo: null, highlightedMountPoint: null }),
  setHighlightedMountPoint: (mp) => set({ highlightedMountPoint: mp }),

  addConnection: (fromId, toId, type = 'data_bus', toMountPointId = null) =>
    set((state) => {
      const alreadyExists = state.assembly.connections.some(
        (conn) =>
          ((conn.from === fromId && conn.to === toId) || (conn.from === toId && conn.to === fromId)) &&
          conn.type === type &&
          (toMountPointId ? conn.toMountPointId === toMountPointId : true),
      )

      if (alreadyExists) return state

      return {
        assembly: {
          ...state.assembly,
          connections: [
            ...state.assembly.connections,
            { from: fromId, to: toId, type, toMountPointId },
          ],
        },
      }
    }),

  removeConnectionsForComponent: (componentId) =>
    set((state) => ({
      assembly: {
        ...state.assembly,
        connections: state.assembly.connections.filter(
          (conn) => conn.from !== componentId && conn.to !== componentId,
        ),
      },
    })),

  // Snapshot / Commit
  commitSnapshot: (message = '') => {
    const state = get()
    const snapshot = {
      id: `snap_${uuidv4().slice(0, 8)}`,
      timestamp: Date.now(),
      message: message || `Snapshot ${state.snapshots.length + 1}`,
      assembly: JSON.parse(JSON.stringify(state.assembly)),
    }
    const newSnapshots = [...state.snapshots, snapshot]
    saveSnapshots(newSnapshots)
    set({ snapshots: newSnapshots })
    return snapshot.id
  },

  loadSnapshot: (snapshotId) => {
    const snapshot = get().snapshots.find((s) => s.id === snapshotId)
    if (snapshot) {
      set({
        assembly: JSON.parse(JSON.stringify(snapshot.assembly)),
        selectedComponentId: null,
        diffResult: null,
        viewMode: 'build',
      })
    }
  },

  deleteSnapshot: (snapshotId) => {
    const newSnapshots = get().snapshots.filter((s) => s.id !== snapshotId)
    saveSnapshots(newSnapshots)
    set({ snapshots: newSnapshots })
  },

  // Diff
  computeDiff: (beforeId, afterId) => {
    const { snapshots } = get()
    const before = snapshots.find((s) => s.id === beforeId)
    const after = snapshots.find((s) => s.id === afterId)
    if (!before || !after) return

    const diff = diffAssemblies(before.assembly, after.assembly)
    set({
      diffResult: diff,
      diffSnapshots: { before: before.assembly, after: after.assembly },
      viewMode: 'diff',
      assembly: JSON.parse(JSON.stringify(after.assembly)),
      selectedComponentId: null,
    })
  },

  clearDiff: () => set({ diffResult: null, diffSnapshots: { before: null, after: null }, viewMode: 'build' }),

  setViewMode: (mode) => set({ viewMode: mode }),
}))

// Diff engine
export function diffAssemblies(before, after) {
  const beforeMap = new Map(before.components.map((c) => [c.id, c]))
  const afterMap = new Map(after.components.map((c) => [c.id, c]))

  const added = []
  const removed = []
  const modified = []
  const moved = []

  // Find added and modified/moved
  for (const [id, comp] of afterMap) {
    if (!beforeMap.has(id)) {
      added.push(id)
    } else {
      const prev = beforeMap.get(id)
      const posChanged =
        prev.position.x !== comp.position.x ||
        prev.position.y !== comp.position.y ||
        prev.position.z !== comp.position.z
      const rotChanged =
        prev.rotation.x !== comp.rotation.x ||
        prev.rotation.y !== comp.rotation.y ||
        prev.rotation.z !== comp.rotation.z
      const metaChanged =
        JSON.stringify(prev.metadata) !== JSON.stringify(comp.metadata) ||
        prev.name !== comp.name

      if (metaChanged) {
        modified.push(id)
      } else if (posChanged || rotChanged) {
        moved.push(id)
      }
    }
  }

  // Find removed
  for (const [id] of beforeMap) {
    if (!afterMap.has(id)) {
      removed.push(id)
    }
  }

  return { added, removed, modified, moved }
}

export function getDiffColor(diffResult, componentId) {
  if (!diffResult) return null
  if (diffResult.added.includes(componentId)) return '#22c55e' // green
  if (diffResult.modified.includes(componentId)) return '#eab308' // yellow
  if (diffResult.removed.includes(componentId)) return '#ef4444' // red
  if (diffResult.moved.includes(componentId)) return '#3b82f6' // blue
  return null
}

export function getDiffLabel(diffResult, componentId) {
  if (!diffResult) return null
  if (diffResult.added.includes(componentId)) return 'Added'
  if (diffResult.modified.includes(componentId)) return 'Modified'
  if (diffResult.removed.includes(componentId)) return 'Removed'
  if (diffResult.moved.includes(componentId)) return 'Moved'
  return null
}

/**
 * Live "git status" hook — continuously diffs the current assembly against the
 * most recent snapshot. In explicit diff mode it returns that diff instead.
 */
export function useWorkingDiff() {
  const assembly  = useAssemblyStore((s) => s.assembly)
  const snapshots = useAssemblyStore((s) => s.snapshots)
  const viewMode  = useAssemblyStore((s) => s.viewMode)
  const explicit  = useAssemblyStore((s) => s.diffResult)

  return useMemo(() => {
    if (viewMode === 'diff' && explicit) return explicit

    const last = snapshots[snapshots.length - 1]
    if (!last) {
      return {
        added:    assembly.components.map((c) => c.id),
        removed:  [],
        modified: [],
        moved:    [],
      }
    }
    return diffAssemblies(last.assembly, assembly)
  }, [assembly, snapshots, viewMode, explicit])
}

/**
 * Returns the "before" assembly for ghost rendering (removed components).
 */
export function useWorkingDiffBase() {
  const snapshots     = useAssemblyStore((s) => s.snapshots)
  const viewMode      = useAssemblyStore((s) => s.viewMode)
  const diffSnapshots = useAssemblyStore((s) => s.diffSnapshots)

  return useMemo(() => {
    if (viewMode === 'diff' && diffSnapshots.before) return diffSnapshots.before
    const last = snapshots[snapshots.length - 1]
    return last ? last.assembly : null
  }, [snapshots, viewMode, diffSnapshots])
}

function connectionKey(conn) {
  const a = conn.from < conn.to ? conn.from : conn.to
  const b = conn.from < conn.to ? conn.to : conn.from
  return `${a}::${b}::${conn.type || 'data_bus'}::${conn.toMountPointId || ''}`
}

export function diffConnections(before, after) {
  const beforeConnections = before.connections || []
  const afterConnections = after.connections || []
  const beforeMap = new Map(beforeConnections.map((conn) => [connectionKey(conn), conn]))
  const afterMap = new Map(afterConnections.map((conn) => [connectionKey(conn), conn]))

  const added = [...afterMap.entries()]
    .filter(([key]) => !beforeMap.has(key))
    .map(([, conn]) => conn)
  const removed = [...beforeMap.entries()]
    .filter(([key]) => !afterMap.has(key))
    .map(([, conn]) => conn)

  return { added, removed }
}

export function useWorkingConnectionDiff() {
  const assembly = useAssemblyStore((s) => s.assembly)
  const snapshots = useAssemblyStore((s) => s.snapshots)
  const viewMode = useAssemblyStore((s) => s.viewMode)
  const diffSnapshots = useAssemblyStore((s) => s.diffSnapshots)

  return useMemo(() => {
    if (viewMode === 'diff' && diffSnapshots.before && diffSnapshots.after) {
      return diffConnections(diffSnapshots.before, diffSnapshots.after)
    }

    const last = snapshots[snapshots.length - 1]
    if (!last) {
      return {
        added: assembly.connections || [],
        removed: [],
      }
    }
    return diffConnections(last.assembly, assembly)
  }, [assembly, snapshots, viewMode, diffSnapshots])
}

export function getConnectionDiffStatus(connectionDiff, conn) {
  if (!connectionDiff) return null
  const key = connectionKey(conn)
  if (connectionDiff.added.some((item) => connectionKey(item) === key)) return 'added'
  if (connectionDiff.removed.some((item) => connectionKey(item) === key)) return 'removed'
  return null
}
