import { Canvas } from "@react-three/fiber";
import {
  Bounds,
  Environment,
  GizmoHelper,
  GizmoViewport,
  Grid,
  Html,
  OrbitControls,
} from "@react-three/drei";
import { Suspense, useMemo } from "react";
import * as THREE from "three";
import type { Constraint, Entity } from "../types";

// ─── tree builder ────────────────────────────────────────────────────────────

type VNode = Entity & { children: VNode[] };

function buildTree(entities: Entity[]): VNode[] {
  const map = new Map<string, VNode>();
  for (const e of entities) map.set(e.id, { ...e, children: [] });
  const roots: VNode[] = [];
  for (const e of entities) {
    if (!e.parentEntityId) {
      roots.push(map.get(e.id)!);
    } else {
      const parent = [...map.values()].find((n) => n.entityId === e.parentEntityId);
      if (parent) parent.children.push(map.get(e.id)!);
      else roots.push(map.get(e.id)!);
    }
  }
  return roots;
}

const toRad = (d: number) => d * (Math.PI / 180);

// ─── per-kind 3D geometry ─────────────────────────────────────────────────────

function AssemblyModel({ color, size }: { color: string; size: number }) {
  const s = size;
  return (
    <group>
      {/* transparent shell */}
      <mesh>
        <boxGeometry args={[s, s * 0.7, s]} />
        <meshStandardMaterial color={color} transparent opacity={0.08} side={THREE.DoubleSide} />
      </mesh>
      {/* wireframe outline */}
      <mesh>
        <boxGeometry args={[s, s * 0.7, s]} />
        <meshBasicMaterial color={color} wireframe transparent opacity={0.4} />
      </mesh>
    </group>
  );
}

function ModuleModel({ color, size }: { color: string; size: number }) {
  const s = size;
  return (
    <group>
      {/* PCB board */}
      <mesh position={[0, 0, 0]} castShadow receiveShadow>
        <boxGeometry args={[s, s * 0.15, s * 0.7]} />
        <meshStandardMaterial color={color} metalness={0.3} roughness={0.65} />
      </mesh>
      {/* chip bumps */}
      {([-0.28, 0, 0.28] as number[]).map((x) =>
        ([-0.18, 0.18] as number[]).map((z) => (
          <mesh key={`${x}-${z}`} position={[x * s, s * 0.11, z * s]} castShadow>
            <boxGeometry args={[s * 0.2, s * 0.1, s * 0.2]} />
            <meshStandardMaterial color="#111827" metalness={0.5} roughness={0.4} />
          </mesh>
        ))
      )}
    </group>
  );
}

function PartModel({ color, size }: { color: string; size: number }) {
  const s = size;
  return (
    <group>
      {/* main body */}
      <mesh position={[0, 0, 0]} castShadow receiveShadow>
        <boxGeometry args={[s, s * 0.55, s]} />
        <meshStandardMaterial color={color} metalness={0.55} roughness={0.3} />
      </mesh>
      {/* top cap */}
      <mesh position={[0, s * 0.32, 0]} castShadow>
        <boxGeometry args={[s * 0.75, s * 0.1, s * 0.75]} />
        <meshStandardMaterial color={color} metalness={0.7} roughness={0.2} />
      </mesh>
      {/* pin row */}
      {([-0.3, -0.15, 0, 0.15, 0.3] as number[]).map((x) => (
        <mesh key={x} position={[x * s, -s * 0.33, 0]}>
          <cylinderGeometry args={[s * 0.025, s * 0.025, s * 0.12, 6]} />
          <meshStandardMaterial color="#9ca3af" metalness={0.9} roughness={0.1} />
        </mesh>
      ))}
    </group>
  );
}

// ─── kind config ─────────────────────────────────────────────────────────────

const KIND_COLOR: Record<string, string> = {
  assembly: "#3b82f6",
  module:   "#f59e0b",
  part:     "#10b981",
};

const KIND_SIZE: Record<string, number> = {
  assembly: 9,
  module:   6,
  part:     3.5,
};

// ─── local axes gizmo ────────────────────────────────────────────────────────

function LocalAxes({ size }: { size: number }) {
  const len = size * 1.3;
  const shaftR = Math.max(size * 0.035, 0.05);
  const coneH = size * 0.28;
  const coneR = size * 0.08;
  const shaftLen = len - coneH;

  const axes: Array<{ color: string; rot: [number, number, number]; label: string }> = [
    { color: "#ef4444", rot: [0, 0, -Math.PI / 2], label: "X" },
    { color: "#22c55e", rot: [0, 0, 0],            label: "Y" },
    { color: "#3b82f6", rot: [Math.PI / 2, 0, 0],  label: "Z" },
  ];

  return (
    <group>
      {axes.map(({ color, rot, label }) => (
        <group key={label} rotation={rot}>
          <mesh position={[0, shaftLen / 2, 0]}>
            <cylinderGeometry args={[shaftR, shaftR, shaftLen, 8]} />
            <meshBasicMaterial color={color} depthTest={false} />
          </mesh>
          <mesh position={[0, shaftLen + coneH / 2, 0]}>
            <coneGeometry args={[coneR, coneH, 8]} />
            <meshBasicMaterial color={color} depthTest={false} />
          </mesh>
          <Html position={[0, len + 1, 0]} center style={{ pointerEvents: "none" }}>
            <span style={{ color, fontSize: 10, fontWeight: 700, textShadow: "0 0 3px #000" }}>
              {label}
            </span>
          </Html>
        </group>
      ))}
    </group>
  );
}

// ─── single entity ───────────────────────────────────────────────────────────

function EntityMesh({
  node,
  isSelected,
  onSelect,
}: {
  node: VNode;
  isSelected: boolean;
  onSelect: (id: string, multi: boolean) => void;
}) {
  const baseColor = KIND_COLOR[node.kind] ?? "#9ca3af";
  const color = isSelected ? "#f59e0b" : baseColor;
  const size = KIND_SIZE[node.kind] ?? 4;

  const Model =
    node.kind === "assembly" ? AssemblyModel
    : node.kind === "module" ? ModuleModel
    : PartModel;

  return (
    <group onClick={(e) => { e.stopPropagation(); onSelect(node.id, e.nativeEvent.shiftKey); }}>
      <Model color={color} size={size} />

      {/* selection ring */}
      {isSelected && (
        <mesh position={[0, 0, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[size * 0.62, size * 0.78, 32]} />
          <meshBasicMaterial color="#f59e0b" transparent opacity={0.7} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* local axes gizmo — shown on selection */}
      {isSelected && <LocalAxes size={size} />}

      {/* floating label */}
      <Html
        position={[0, size * 0.55 + 1.5, 0]}
        center
        distanceFactor={60}
        zIndexRange={[10, 0]}
        style={{ pointerEvents: "none" }}
      >
        <div
          style={{
            background: isSelected ? "#f59e0b" : "rgba(255,255,255,0.92)",
            color: isSelected ? "#fff" : "#1e293b",
            padding: "2px 8px",
            borderRadius: 4,
            fontSize: 11,
            fontWeight: 600,
            whiteSpace: "nowrap",
            boxShadow: "0 2px 6px rgba(0,0,0,0.18)",
            border: `1px solid ${isSelected ? "#d97706" : "#e2e8f0"}`,
          }}
        >
          {node.name}
        </div>
      </Html>
    </group>
  );
}

// ─── recursive scene node ─────────────────────────────────────────────────────

function SceneNode({
  node,
  selectedIds,
  onSelect,
}: {
  node: VNode;
  selectedIds: string[];
  onSelect: (id: string, multi: boolean) => void;
}) {
  const p = (node.transform?.position ?? [0, 0, 0]) as [number, number, number];
  const r = (node.transform ? node.transform.rotationEulerDeg.map(toRad) : [0, 0, 0]) as [number, number, number];
  const s = (node.transform?.scale ?? [1, 1, 1]) as [number, number, number];

  return (
    <group position={p} rotation={r} scale={s}>
      {node.transform !== null && (
        <EntityMesh node={node} isSelected={selectedIds.includes(node.id)} onSelect={onSelect} />
      )}
      {node.children.map((child) => (
        <SceneNode key={child.id} node={child} selectedIds={selectedIds} onSelect={onSelect} />
      ))}
    </group>
  );
}

// ─── public component ─────────────────────────────────────────────────────────

type Props = {
  entities: Entity[];
  constraints: Constraint[];
  selectedIds: string[];
  onSelect: (id: string, multi: boolean) => void;
};

export function Viewport({ entities, selectedIds, onSelect }: Props) {
  const roots = useMemo(() => buildTree(entities), [entities]);

  return (
    <Canvas
      shadows
      camera={{ position: [80, 80, 120], fov: 45, near: 0.1, far: 50000 }}
      gl={{ antialias: true }}
      style={{ background: "#0f172a" }}
    >
      <ambientLight intensity={0.5} />
      <directionalLight position={[60, 120, 80]} intensity={1.4} castShadow />
      <directionalLight position={[-60, 40, -80]} intensity={0.4} />

      <Suspense fallback={null}>
        <Environment preset="city" />

        <Bounds fit clip observe damping={6} margin={1.4}>
          <group>
            {roots.map((root) => (
              <SceneNode key={root.id} node={root} selectedIds={selectedIds} onSelect={onSelect} />
            ))}
          </group>
        </Bounds>

        <Grid
          args={[500, 500]}
          position={[0, -6, 0]}
          cellSize={5}
          cellThickness={0.5}
          cellColor="#1e293b"
          sectionSize={25}
          sectionThickness={1}
          sectionColor="#334155"
          fadeDistance={400}
          fadeStrength={1}
          followCamera={false}
          infiniteGrid
        />
      </Suspense>

      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        maxPolarAngle={Math.PI / 2.05}
        minDistance={5}
        maxDistance={2000}
      />

      <GizmoHelper alignment="bottom-right" margin={[70, 70]}>
        <GizmoViewport axisColors={["#ef4444", "#22c55e", "#3b82f6"]} labelColor="white" />
      </GizmoHelper>
    </Canvas>
  );
}
