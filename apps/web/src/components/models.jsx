import * as THREE from 'three'

// ---------------------------------------------------------------------------
// CPU
// ---------------------------------------------------------------------------

export function CpuModel({ color }) {
  return (
    <group>
      <mesh position={[0, 0.15, 0]} castShadow>
        <boxGeometry args={[1.2, 0.3, 1.2]} />
        <meshStandardMaterial color={color || '#d97706'} metalness={0.6} roughness={0.3} />
      </mesh>
      <mesh position={[0, 0.35, 0]} castShadow>
        <boxGeometry args={[0.9, 0.1, 0.9]} />
        <meshStandardMaterial color={color || '#b45309'} metalness={0.8} roughness={0.2} />
      </mesh>
      {[-0.4, -0.2, 0, 0.2, 0.4].map((x) =>
        [-0.4, -0.2, 0, 0.2, 0.4].map((z) => (
          <mesh key={`${x}_${z}`} position={[x, -0.05, z]}>
            <cylinderGeometry args={[0.02, 0.02, 0.1, 6]} />
            <meshStandardMaterial color={color || '#a3a3a3'} metalness={0.9} roughness={0.1} />
          </mesh>
        )),
      )}
    </group>
  )
}

// ---------------------------------------------------------------------------
// RAM
// ---------------------------------------------------------------------------

export function RamModel({ color }) {
  return (
    <group>
      <mesh position={[0, 0.4, 0]} castShadow>
        <boxGeometry args={[2, 0.8, 0.08]} />
        <meshStandardMaterial color={color || '#059669'} metalness={0.3} roughness={0.6} />
      </mesh>
      {[-0.6, -0.2, 0.2, 0.6].map((x) => (
        <mesh key={x} position={[x, 0.4, 0.06]} castShadow>
          <boxGeometry args={[0.3, 0.25, 0.04]} />
          <meshStandardMaterial color={color || '#111827'} metalness={0.5} roughness={0.4} />
        </mesh>
      ))}
      <mesh position={[0, -0.05, 0]}>
        <boxGeometry args={[1.8, 0.1, 0.04]} />
        <meshStandardMaterial color={color || '#fbbf24'} metalness={0.9} roughness={0.1} />
      </mesh>
    </group>
  )
}

// ---------------------------------------------------------------------------
// Motherboard
// ---------------------------------------------------------------------------

export function MotherboardModel({ color }) {
  return (
    <group>
      <mesh position={[0, 0.05, 0]} castShadow receiveShadow>
        <boxGeometry args={[3, 0.1, 2.5]} />
        <meshStandardMaterial color={color || '#166534'} metalness={0.3} roughness={0.7} />
      </mesh>
      <mesh position={[-0.5, 0.11, -0.3]}>
        <boxGeometry args={[1.3, 0.02, 1.3]} />
        <meshStandardMaterial color={color || '#1e3a2f'} metalness={0.4} roughness={0.5} />
      </mesh>
      {[0, 0.15, 0.3, 0.45].map((z) => (
        <mesh key={z} position={[0.9, 0.12, -0.6 + z]}>
          <boxGeometry args={[0.08, 0.04, 0.5]} />
          <meshStandardMaterial color={color || '#374151'} metalness={0.5} roughness={0.4} />
        </mesh>
      ))}
      <mesh position={[0.2, 0.13, 0.5]}>
        <boxGeometry args={[0.5, 0.06, 0.5]} />
        <meshStandardMaterial color={color || '#1f2937'} metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh position={[-1.35, 0.2, -0.3]}>
        <boxGeometry args={[0.3, 0.3, 1.5]} />
        <meshStandardMaterial color={color || '#4b5563'} metalness={0.6} roughness={0.3} />
      </mesh>
      {[[-1.3, 0.11, -1.1], [1.3, 0.11, -1.1], [-1.3, 0.11, 1.1], [1.3, 0.11, 1.1]].map(([x, y, z]) => (
        <mesh key={`${x}_${z}`} position={[x, y, z]}>
          <cylinderGeometry args={[0.08, 0.08, 0.02, 16]} />
          <meshStandardMaterial color={color || '#9ca3af'} metalness={0.8} roughness={0.2} />
        </mesh>
      ))}
    </group>
  )
}

// ---------------------------------------------------------------------------
// GPU
// ---------------------------------------------------------------------------

export function GpuModel({ color }) {
  return (
    <group>
      {/* PCB backplate */}
      <mesh position={[0, 0.25, 0]} castShadow>
        <boxGeometry args={[2.4, 0.08, 1.2]} />
        <meshStandardMaterial color={color || '#1f2937'} metalness={0.5} roughness={0.4} />
      </mesh>
      {/* Shroud / cooler body */}
      <mesh position={[0, 0.1, 0]} castShadow>
        <boxGeometry args={[2.3, 0.22, 1.1]} />
        <meshStandardMaterial color={color || '#374151'} metalness={0.4} roughness={0.5} />
      </mesh>
      {/* Fans */}
      {[-0.55, 0.55].map((x) => (
        <mesh key={x} position={[x, -0.02, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.4, 0.4, 0.04, 24]} />
          <meshStandardMaterial color={color || '#111827'} metalness={0.3} roughness={0.6} />
        </mesh>
      ))}
      {/* Gold PCIe connector */}
      <mesh position={[0, 0.32, -0.45]}>
        <boxGeometry args={[1.6, 0.04, 0.08]} />
        <meshStandardMaterial color={color || '#fbbf24'} metalness={0.9} roughness={0.1} />
      </mesh>
      {/* Display ports */}
      {[-0.3, -0.1, 0.1].map((z) => (
        <mesh key={z} position={[-1.15, 0.2, z]}>
          <boxGeometry args={[0.06, 0.08, 0.12]} />
          <meshStandardMaterial color={color || '#6b7280'} metalness={0.7} roughness={0.2} />
        </mesh>
      ))}
    </group>
  )
}

// ---------------------------------------------------------------------------
// SSD (NVMe M.2)
// ---------------------------------------------------------------------------

export function SsdModel({ color }) {
  return (
    <group>
      {/* PCB */}
      <mesh position={[0, 0.05, 0]} castShadow>
        <boxGeometry args={[1.4, 0.04, 0.35]} />
        <meshStandardMaterial color={color || '#166534'} metalness={0.3} roughness={0.7} />
      </mesh>
      {/* NAND chip */}
      <mesh position={[0.1, 0.09, 0]} castShadow>
        <boxGeometry args={[0.6, 0.04, 0.25]} />
        <meshStandardMaterial color={color || '#111827'} metalness={0.5} roughness={0.4} />
      </mesh>
      {/* Controller */}
      <mesh position={[-0.4, 0.09, 0]} castShadow>
        <boxGeometry args={[0.25, 0.04, 0.25]} />
        <meshStandardMaterial color={color || '#1f2937'} metalness={0.5} roughness={0.4} />
      </mesh>
      {/* M.2 connector notch */}
      <mesh position={[0.68, 0.05, 0]}>
        <boxGeometry args={[0.06, 0.06, 0.3]} />
        <meshStandardMaterial color={color || '#fbbf24'} metalness={0.9} roughness={0.1} />
      </mesh>
    </group>
  )
}

// ---------------------------------------------------------------------------
// PSU
// ---------------------------------------------------------------------------

export function PsuModel({ color }) {
  return (
    <group>
      {/* Main box */}
      <mesh position={[0, 0.3, 0]} castShadow>
        <boxGeometry args={[1.4, 0.6, 1]} />
        <meshStandardMaterial color={color || '#374151'} metalness={0.5} roughness={0.4} />
      </mesh>
      {/* Fan grille (top face) */}
      <mesh position={[0, 0.61, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.35, 0.35, 0.02, 24]} />
        <meshStandardMaterial color={color || '#1f2937'} metalness={0.3} roughness={0.6} />
      </mesh>
      {/* Label area */}
      <mesh position={[0, 0.3, 0.51]}>
        <boxGeometry args={[1, 0.3, 0.01]} />
        <meshStandardMaterial color={color || '#4b5563'} metalness={0.2} roughness={0.8} />
      </mesh>
      {/* Cable outputs */}
      {[-0.3, 0, 0.3].map((x) => (
        <mesh key={x} position={[x, 0.3, -0.52]}>
          <cylinderGeometry args={[0.06, 0.06, 0.06, 8]} />
          <meshStandardMaterial color={color || '#111827'} metalness={0.4} roughness={0.5} />
        </mesh>
      ))}
      {/* Power switch */}
      <mesh position={[0.55, 0.5, -0.51]}>
        <boxGeometry args={[0.12, 0.08, 0.02]} />
        <meshStandardMaterial color={color || '#ef4444'} metalness={0.3} roughness={0.5} />
      </mesh>
    </group>
  )
}

// ---------------------------------------------------------------------------
// CPU Cooler
// ---------------------------------------------------------------------------

export function CoolerModel({ color }) {
  return (
    <group>
      {/* Base plate */}
      <mesh position={[0, 0.02, 0]} castShadow>
        <boxGeometry args={[0.8, 0.04, 0.8]} />
        <meshStandardMaterial color={color || '#b45309'} metalness={0.8} roughness={0.2} />
      </mesh>
      {/* Heatsink fins (stacked) */}
      {Array.from({ length: 8 }, (_, i) => (
        <mesh key={i} position={[0, 0.1 + i * 0.09, 0]} castShadow>
          <boxGeometry args={[0.7, 0.02, 0.7]} />
          <meshStandardMaterial color={color || '#9ca3af'} metalness={0.7} roughness={0.3} />
        </mesh>
      ))}
      {/* Heat pipes */}
      {[-0.15, 0.15].map((x) => (
        <mesh key={x} position={[x, 0.4, 0]} castShadow>
          <cylinderGeometry args={[0.04, 0.04, 0.76, 8]} />
          <meshStandardMaterial color={color || '#d97706'} metalness={0.9} roughness={0.1} />
        </mesh>
      ))}
      {/* Fan (on the side) */}
      <mesh position={[0.45, 0.4, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.35, 0.35, 0.06, 20]} />
        <meshStandardMaterial color={color || '#1f2937'} metalness={0.3} roughness={0.6} />
      </mesh>
    </group>
  )
}

// ---------------------------------------------------------------------------
// Case / Chassis
// ---------------------------------------------------------------------------

export function CaseModel({ color }) {
  return (
    <group>
      {/* Main body — semi-transparent to see inside */}
      <mesh position={[0, 1, 0]} castShadow>
        <boxGeometry args={[2.5, 2, 2]} />
        <meshStandardMaterial
          color={color || '#1f2937'}
          metalness={0.4}
          roughness={0.5}
          transparent
          opacity={0.35}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Wireframe overlay */}
      <mesh position={[0, 1, 0]}>
        <boxGeometry args={[2.5, 2, 2]} />
        <meshBasicMaterial color={color || '#4b5563'} wireframe transparent opacity={0.5} />
      </mesh>
      {/* Front IO panel */}
      <mesh position={[0, 1.85, -0.95]}>
        <boxGeometry args={[0.8, 0.08, 0.08]} />
        <meshStandardMaterial color={color || '#6b7280'} metalness={0.6} roughness={0.3} />
      </mesh>
      {/* Front fan intakes */}
      {[-0.5, 0, 0.5].map((y) => (
        <mesh key={y} position={[-1.26, 1 + y, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.3, 0.3, 0.02, 20]} />
          <meshStandardMaterial color={color || '#111827'} metalness={0.3} roughness={0.6} />
        </mesh>
      ))}
      {/* PSU shroud at bottom */}
      <mesh position={[0, 0.15, 0]}>
        <boxGeometry args={[2.48, 0.3, 1.98]} />
        <meshStandardMaterial color={color || '#111827'} metalness={0.4} roughness={0.5} transparent opacity={0.6} />
      </mesh>
    </group>
  )
}

