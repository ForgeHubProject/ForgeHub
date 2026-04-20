import { Canvas } from '@react-three/fiber'
import { OrbitControls, Grid, GizmoHelper, GizmoViewport, Environment } from '@react-three/drei'
import { useAssemblyStore, getDiffColor, getDiffLabel, useWorkingDiff, useWorkingDiffBase } from '../store/useAssemblyStore'
import { useRef, useCallback, useMemo } from 'react'
import HardwareComponent from './HardwareComponent'
import ConnectionLine from './ConnectionLine'

function Scene() {
  const components = useAssemblyStore((s) => s.assembly.components)
  const connections = useAssemblyStore((s) => s.assembly.connections)
  const selectedComponentId = useAssemblyStore((s) => s.selectedComponentId)
  const selectComponent = useAssemblyStore((s) => s.selectComponent)
  const viewMode = useAssemblyStore((s) => s.viewMode)

  const workingDiff = useWorkingDiff()
  const diffBase = useWorkingDiffBase()

  const removedComponents = useMemo(() => {
    if (!workingDiff || !diffBase) return []
    return diffBase.components.filter((c) => workingDiff.removed.includes(c.id))
  }, [workingDiff, diffBase])

  const handleMissedClick = useCallback(() => {
    selectComponent(null)
  }, [selectComponent])

  return (
    <>
      <ambientLight intensity={0.4} />
      <directionalLight position={[10, 10, 5]} intensity={1} castShadow />
      <directionalLight position={[-5, 8, -5]} intensity={0.3} />

      {/* Ground plane for click-miss detection */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} onPointerDown={handleMissedClick}>
        <planeGeometry args={[100, 100]} />
        <meshStandardMaterial transparent opacity={0} />
      </mesh>

      {/* Grid */}
      <Grid
        args={[20, 20]}
        position={[0, 0, 0]}
        cellSize={1}
        cellThickness={0.5}
        cellColor="#2a2a4a"
        sectionSize={5}
        sectionThickness={1}
        sectionColor="#3a3a5a"
        fadeDistance={30}
        fadeStrength={1}
        infiniteGrid
      />

      {/* Components */}
      {components.map((comp) => (
        <HardwareComponent
          key={comp.id}
          component={comp}
          isSelected={selectedComponentId === comp.id}
          diffColor={getDiffColor(workingDiff, comp.id)}
          diffLabel={getDiffLabel(workingDiff, comp.id)}
          isDiffMode={viewMode === 'diff'}
        />
      ))}

      {/* Removed components (ghost) — visible in both modes */}
      {removedComponents.map((comp) => (
        <HardwareComponent
          key={comp.id}
          component={comp}
          isSelected={false}
          diffColor="#ef4444"
          diffLabel="Removed"
          isDiffMode={true}
          isGhost={true}
        />
      ))}

      {/* Connection lines */}
      {connections.map((conn, i) => {
        const fromComp = components.find((c) => c.id === conn.from)
        const toComp = components.find((c) => c.id === conn.to)
        if (!fromComp || !toComp) return null
        return <ConnectionLine key={i} from={fromComp.position} to={toComp.position} type={conn.type} />
      })}

      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.1}
        maxPolarAngle={Math.PI / 2.1}
        minDistance={3}
        maxDistance={25}
      />
      <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
        <GizmoViewport labelColor="white" axisHeadScale={0.8} />
      </GizmoHelper>
      <Environment preset="city" />
    </>
  )
}

export default function Canvas3D() {
  const addComponent = useAssemblyStore((s) => s.addComponent)
  const canvasRef = useRef()

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    const type = e.dataTransfer.getData('component-type')
    if (!type) return

    // Convert screen position to rough world position
    const rect = canvasRef.current.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width - 0.5) * 8
    const z = ((e.clientY - rect.top) / rect.height - 0.5) * 8

    addComponent(type, { x, y: 0.5, z })
  }, [addComponent])

  const handleDragOver = useCallback((e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  return (
    <div
      ref={canvasRef}
      className="w-full h-full"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <Canvas
        shadows
        camera={{ position: [6, 6, 6], fov: 50 }}
        gl={{ antialias: true }}
      >
        <Scene />
      </Canvas>
    </div>
  )
}
