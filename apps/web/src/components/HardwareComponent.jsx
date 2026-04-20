/* eslint-disable react-hooks/immutability */
import { useRef, useState, useCallback } from 'react'
import { useThree } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import { useAssemblyStore } from '../store/useAssemblyStore'
import { getDescriptor } from '../domain/componentRegistry'
import { inferConnectorType } from '../domain/connectorRegistry'
import { CpuModel } from './models'
import { MODEL_MAP } from './modelMap'
import * as THREE from 'three'

const shiftState = { held: false }
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => { if (e.key === 'Shift') shiftState.held = true })
  window.addEventListener('keyup',   (e) => { if (e.key === 'Shift') shiftState.held = false })
  window.addEventListener('blur',    ()  => { shiftState.held = false })
}

const SNAP_DISTANCE = 1.5

const BOUNDS = {
  cpu:         { size: [1.4, 0.6, 1.4], center: 0.2 },
  ram:         { size: [2.2, 1.0, 0.3], center: 0.3 },
  motherboard: { size: [3.2, 0.3, 2.7], center: 0.1 },
  gpu:         { size: [2.6, 0.5, 1.4], center: 0.15 },
  ssd:         { size: [1.6, 0.2, 0.5], center: 0.06 },
  psu:         { size: [1.6, 0.8, 1.2], center: 0.3 },
  cooler:      { size: [1.1, 1.0, 0.9], center: 0.4 },
  case:        { size: [2.7, 2.2, 2.2], center: 1.0 },
}
const DEFAULT_BOUNDS = { size: [1.4, 0.6, 1.4], center: 0.2 }

const LABEL_COLORS = {
  Added:    { bg: '#22c55e', text: '#fff' },
  Modified: { bg: '#eab308', text: '#fff' },
  Moved:    { bg: '#3b82f6', text: '#fff' },
  Removed:  { bg: '#ef4444', text: '#fff' },
}

function findSnapTarget(draggedType, draggedPos, allComponents, draggedId) {
  const desc = getDescriptor(draggedType)
  if (!desc || desc.fitsInSlots.length === 0) return null

  let best = null
  let bestDist = SNAP_DISTANCE

  for (const comp of allComponents) {
    if (comp.id === draggedId) continue
    const parentDesc = getDescriptor(comp.model)
    if (!parentDesc) continue

    for (const mp of parentDesc.mountPoints) {
      if (!desc.fitsInSlots.includes(mp.slotType)) continue

      const wx = comp.position.x + mp.localPosition.x
      const wy = comp.position.y + mp.localPosition.y
      const wz = comp.position.z + mp.localPosition.z

      const dx = draggedPos.x - wx
      const dy = draggedPos.y - wy
      const dz = draggedPos.z - wz
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

      if (dist < bestDist) {
        bestDist = dist
        best = {
          componentId: comp.id,
          componentType: comp.model,
          mountPointId: mp.id,
          worldPosition: { x: wx, y: wy, z: wz },
          distance: dist,
        }
      }
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Mount point markers rendered on a target component while something
// compatible is being dragged
// ---------------------------------------------------------------------------

function MountPointMarkers({ component }) {
  const draggingInfo = useAssemblyStore((s) => s.draggingInfo)
  const highlighted = useAssemblyStore((s) => s.highlightedMountPoint)

  const desc = getDescriptor(component.model)
  if (!desc || desc.mountPoints.length === 0) return null
  if (!draggingInfo || draggingInfo.componentId === component.id) return null

  const draggedDesc = getDescriptor(draggingInfo.componentType)
  if (!draggedDesc) return null

  return desc.mountPoints.map((mp) => {
    const compatible = draggedDesc.fitsInSlots.includes(mp.slotType)
    if (!compatible) return null

    const isHighlighted =
      highlighted?.componentId === component.id &&
      highlighted?.mountPointId === mp.id

    const color = isHighlighted ? '#22d3ee' : '#4ade80'
    const scale = isHighlighted ? 1.6 : 1
    const opacity = isHighlighted ? 0.95 : 0.5

    return (
      <group key={mp.id} position={[mp.localPosition.x, mp.localPosition.y, mp.localPosition.z]}>
        <mesh scale={scale}>
          <octahedronGeometry args={[0.1, 0]} />
          <meshBasicMaterial color={color} transparent opacity={opacity} />
        </mesh>
        {isHighlighted && (
          <>
            <mesh rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[0.15, 0.22, 24]} />
              <meshBasicMaterial color="#22d3ee" transparent opacity={0.7} side={THREE.DoubleSide} />
            </mesh>
            <Html position={[0, 0.35, 0]} center distanceFactor={8} zIndexRange={[50, 0]}>
              <div
                style={{
                  background: '#22d3ee',
                  color: '#000',
                  padding: '2px 6px',
                  borderRadius: 4,
                  fontSize: 10,
                  fontWeight: 700,
                  whiteSpace: 'nowrap',
                  pointerEvents: 'none',
                  boxShadow: '0 2px 6px rgba(0,0,0,.5)',
                }}
              >
                {mp.label}
              </div>
            </Html>
          </>
        )}
      </group>
    )
  })
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function HardwareComponent({ component, isSelected, diffColor, diffLabel, isDiffMode, isGhost = false }) {
  const meshRef = useRef()
  const selectComponent = useAssemblyStore((s) => s.selectComponent)
  const updateComponentPosition = useAssemblyStore((s) => s.updateComponentPosition)
  const addConnection = useAssemblyStore((s) => s.addConnection)
  const setHoveredComponent = useAssemblyStore((s) => s.setHoveredComponent)
  const setDraggingInfo = useAssemblyStore((s) => s.setDraggingInfo)
  const clearDraggingInfo = useAssemblyStore((s) => s.clearDraggingInfo)
  const setHighlightedMountPoint = useAssemblyStore((s) => s.setHighlightedMountPoint)
  const hoveredComponentId = useAssemblyStore((s) => s.hoveredComponentId)
  const allComponents = useAssemblyStore((s) => s.assembly.components)
  const allConnections = useAssemblyStore((s) => s.assembly.connections)

  const [isDragging, setIsDragging] = useState(false)
  const controls = useThree((state) => state.controls)
  const camera = useThree((state) => state.camera)
  const isHovered = hoveredComponentId === component.id

  const horizontalPlane = useRef(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0))
  const verticalPlane = useRef(new THREE.Plane())
  const dragOffset = useRef(new THREE.Vector3())
  const shiftHeld = useRef(false)
  const currentSnap = useRef(null)

  const ModelComponent = MODEL_MAP[component.model] || CpuModel

  const buildVerticalPlane = useCallback((objectPos) => {
    const camDir = new THREE.Vector3()
    camera.getWorldDirection(camDir)
    camDir.y = 0
    camDir.normalize()
    verticalPlane.current.setFromNormalAndCoplanarPoint(camDir, objectPos)
  }, [camera])

  const handlePointerDown = (e) => {
    if (isDiffMode || isGhost) return
    e.stopPropagation()
    selectComponent(component.id)
    setIsDragging(true)
    setDraggingInfo({ componentId: component.id, componentType: component.model })

    if (controls) controls.enabled = false

    shiftHeld.current = shiftState.held
    currentSnap.current = null

    const objPos = new THREE.Vector3(component.position.x, component.position.y, component.position.z)
    horizontalPlane.current.set(new THREE.Vector3(0, 1, 0), -objPos.y)
    buildVerticalPlane(objPos)

    const plane = shiftHeld.current ? verticalPlane.current : horizontalPlane.current
    const intersect = new THREE.Vector3()
    e.ray.intersectPlane(plane, intersect)
    dragOffset.current.copy(intersect).sub(objPos)

    e.target.setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e) => {
    if (!isDragging || isDiffMode) return
    e.stopPropagation()

    const nowShift = shiftState.held
    if (nowShift !== shiftHeld.current) {
      shiftHeld.current = nowShift
      const objPos = new THREE.Vector3(component.position.x, component.position.y, component.position.z)
      horizontalPlane.current.set(new THREE.Vector3(0, 1, 0), -objPos.y)
      buildVerticalPlane(objPos)
      const plane = nowShift ? verticalPlane.current : horizontalPlane.current
      const intersect = new THREE.Vector3()
      e.ray.intersectPlane(plane, intersect)
      dragOffset.current.copy(intersect).sub(objPos)
      return
    }

    const plane = shiftHeld.current ? verticalPlane.current : horizontalPlane.current
    const intersect = new THREE.Vector3()
    e.ray.intersectPlane(plane, intersect)
    intersect.sub(dragOffset.current)

    const snap = (v) => Math.round(v * 4) / 4

    let finalPos
    if (shiftHeld.current) {
      finalPos = { x: component.position.x, y: Math.max(0, snap(intersect.y)), z: component.position.z }
    } else {
      finalPos = { x: snap(intersect.x), y: component.position.y, z: snap(intersect.z) }
    }

    const target = findSnapTarget(component.model, finalPos, allComponents, component.id)

    if (target) {
      currentSnap.current = target
      setHighlightedMountPoint({ componentId: target.componentId, mountPointId: target.mountPointId })
      updateComponentPosition(component.id, target.worldPosition)
    } else {
      currentSnap.current = null
      setHighlightedMountPoint(null)
      updateComponentPosition(component.id, finalPos)
    }
  }

  const handlePointerUp = (e) => {
    setIsDragging(false)
    if (controls) controls.enabled = true

    if (currentSnap.current) {
      const parentId = currentSnap.current.componentId
      const childId = component.id
      const alreadyConnected = allConnections.some(
        (c) => (c.from === childId && c.to === parentId) || (c.from === parentId && c.to === childId),
      )
      if (!alreadyConnected) {
        const connType = inferConnectorType(component.model, currentSnap.current.componentType)
        addConnection(childId, parentId, connType)
      }
      currentSnap.current = null
    }

    clearDraggingInfo()

    if (e.target.releasePointerCapture) {
      e.target.releasePointerCapture(e.pointerId)
    }
  }

  return (
    <group
      ref={meshRef}
      position={[component.position.x, component.position.y, component.position.z]}
      rotation={[component.rotation.x, component.rotation.y, component.rotation.z]}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerEnter={() => setHoveredComponent(component.id)}
      onPointerLeave={() => setHoveredComponent(null)}
    >
      <ModelComponent color={isDiffMode ? diffColor : undefined} />

      {/* Mount point indicators on this component when something compatible is being dragged */}
      {!isGhost && <MountPointMarkers component={component} />}

      {/* Floating diff label on hover */}
      {diffLabel && (isHovered || isGhost) && (() => {
        const b = BOUNDS[component.model] || DEFAULT_BOUNDS
        const labelStyle = LABEL_COLORS[diffLabel]
        if (!labelStyle) return null
        return (
          <Html position={[0, b.size[1] + 0.4, 0]} center distanceFactor={8} zIndexRange={[50, 0]}>
            <div
              style={{
                background: labelStyle.bg,
                color: labelStyle.text,
                padding: '2px 8px',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 700,
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
                boxShadow: '0 2px 8px rgba(0,0,0,.4)',
                userSelect: 'none',
              }}
            >
              {diffLabel}
            </div>
          </Html>
        )
      })()}

      {/* Selection outline */}
      {isSelected && !isDiffMode && (() => {
        const b = BOUNDS[component.model] || DEFAULT_BOUNDS
        return (
          <mesh position={[0, b.center, 0]}>
            <boxGeometry args={b.size} />
            <meshBasicMaterial color="#22d3ee" wireframe transparent opacity={0.5} />
          </mesh>
        )
      })()}

      {/* Ghost overlay for removed components */}
      {isGhost && (() => {
        const b = BOUNDS[component.model] || DEFAULT_BOUNDS
        return (
          <mesh position={[0, b.center, 0]}>
            <boxGeometry args={b.size} />
            <meshBasicMaterial color="#ef4444" transparent opacity={0.15} />
          </mesh>
        )
      })()}

      {/* Diff color indicator ring */}
      {diffColor && (() => {
        const b = BOUNDS[component.model] || DEFAULT_BOUNDS
        const r = Math.max(b.size[0], b.size[2]) / 2
        return (
          <mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[r, r + 0.2, 32]} />
            <meshBasicMaterial color={diffColor} transparent opacity={0.6} side={THREE.DoubleSide} />
          </mesh>
        )
      })()}
    </group>
  )
}
