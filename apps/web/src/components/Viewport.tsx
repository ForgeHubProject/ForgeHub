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
import { Suspense, useMemo, useState } from "react";
import * as THREE from "three";
import type { Constraint, DiffChange, DiffChangeType, DiffEntitySnapshot, Entity } from "../types";

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

// ─── diff color mapping ───────────────────────────────────────────────────────

const DIFF_COLOR: Record<DiffChangeType, string> = {
  added:     "#22c55e",
  removed:   "#ef4444",
  modified:  "#f59e0b",
  moved:     "#f97316",
  unchanged: "#475569",
};

// ─── per-kind 3D geometry ─────────────────────────────────────────────────────

function AssemblyModel({ color, size }: { color: string; size: number }) {
  const s = Math.max(0.6, size * 0.22);
  return (
    <mesh castShadow receiveShadow>
      <octahedronGeometry args={[s, 0]} />
      <meshStandardMaterial color={color} metalness={0.45} roughness={0.35} />
    </mesh>
  );
}

function ModuleModel({ color, size }: { color: string; size: number }) {
  const s = size;
  return (
    <group>
      <mesh position={[0, 0, 0]} castShadow receiveShadow>
        <boxGeometry args={[s, s * 0.15, s * 0.7]} />
        <meshStandardMaterial color={color} metalness={0.3} roughness={0.65} />
      </mesh>
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
      <mesh position={[0, 0, 0]} castShadow receiveShadow>
        <boxGeometry args={[s, s * 0.55, s]} />
        <meshStandardMaterial color={color} metalness={0.55} roughness={0.3} />
      </mesh>
      <mesh position={[0, s * 0.32, 0]} castShadow>
        <boxGeometry args={[s * 0.75, s * 0.1, s * 0.75]} />
        <meshStandardMaterial color={color} metalness={0.7} roughness={0.2} />
      </mesh>
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
  assembly: 2.4,
  module:   6,
  part:     3.5,
};

// ─── removed entity ghost ─────────────────────────────────────────────────────

function GhostEntity({ snap, onSelect }: { snap: DiffEntitySnapshot; onSelect?: (entityId: string) => void }) {
  const p = (snap.transform?.position ?? [0, 0, 0]) as [number, number, number];
  const r = (snap.transform ? snap.transform.rotationEulerDeg.map(toRad) : [0, 0, 0]) as [number, number, number];
  const s = (snap.transform?.scale ?? [1, 1, 1]) as [number, number, number];
  const size = KIND_SIZE[snap.kind] ?? 4;

  return (
    <group position={p} rotation={r} scale={s} onClick={(e) => { e.stopPropagation(); onSelect?.(snap.entityId); }}>
      <mesh>
        <boxGeometry args={[size, size * 0.7, size]} />
        <meshBasicMaterial color="#ef4444" wireframe transparent opacity={0.55} />
      </mesh>
      <Html
        position={[0, size * 0.5 + 1.5, 0]}
        center
        distanceFactor={60}
        zIndexRange={[10, 0]}
        style={{ pointerEvents: "none" }}
      >
        <div style={{
          background: "#ef4444", color: "#fff",
          padding: "2px 8px", borderRadius: 4,
          fontSize: 11, fontWeight: 600, whiteSpace: "nowrap",
          boxShadow: "0 2px 6px rgba(0,0,0,0.18)", opacity: 0.85,
        }}>
          — {snap.name}
        </div>
      </Html>
    </group>
  );
}

// ─── single entity ───────────────────────────────────────────────────────────

function EntityMesh({
  node,
  isSelected,
  onSelect,
  diffType,
}: {
  node: VNode;
  isSelected: boolean;
  onSelect: (id: string) => void;
  diffType?: DiffChangeType;
}) {
  const [hovered, setHovered] = useState(false);
  const baseColor = KIND_COLOR[node.kind] ?? "#9ca3af";
  const color = isSelected
    ? "#f59e0b"
    : diffType
    ? DIFF_COLOR[diffType]
    : baseColor;
  const size = KIND_SIZE[node.kind] ?? 4;

  const Model =
    node.kind === "assembly" ? AssemblyModel
    : node.kind === "module" ? ModuleModel
    : PartModel;

  const labelBg =
    isSelected          ? "#f59e0b"
    : diffType === "added"     ? "#22c55e"
    : diffType === "modified"  ? "#f59e0b"
    : diffType === "moved"     ? "#f97316"
    : diffType === "unchanged" ? "rgba(71,85,105,0.75)"
    : "rgba(255,255,255,0.92)";

  const labelTextColor = (diffType && diffType !== "unchanged") || isSelected ? "#fff" : "#1e293b";

  return (
    <group
      onClick={(e) => { e.stopPropagation(); onSelect(node.id); }}
      onPointerOver={(e) => { e.stopPropagation(); setHovered(true); }}
      onPointerOut={() => setHovered(false)}
    >
      <Model color={color} size={size} />

      {isSelected && (
        <mesh position={[0, 0, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[size * 0.62, size * 0.78, 32]} />
          <meshBasicMaterial color="#f59e0b" transparent opacity={0.7} side={THREE.DoubleSide} />
        </mesh>
      )}

      {(isSelected || hovered || diffType) && (
        <Html
          position={[0, size * 0.55 + 1.5, 0]}
          center
          distanceFactor={60}
          zIndexRange={[10, 0]}
          style={{ pointerEvents: "none" }}
        >
          <div style={{
            background: labelBg,
            color: labelTextColor,
            padding: "2px 8px", borderRadius: 4,
            fontSize: 11, fontWeight: 600, whiteSpace: "nowrap",
            boxShadow: "0 2px 6px rgba(0,0,0,0.18)",
            border: `1px solid ${isSelected ? "#d97706" : "transparent"}`,
          }}>
            {node.name}
          </div>
        </Html>
      )}
    </group>
  );
}

// ─── recursive scene node ─────────────────────────────────────────────────────

function SceneNode({
  node,
  selectedIds,
  onSelect,
  diffTypeMap,
}: {
  node: VNode;
  selectedIds: string[];
  onSelect: (id: string) => void;
  diffTypeMap: Map<string, DiffChangeType> | null;
}) {
  const p = (node.transform?.position ?? [0, 0, 0]) as [number, number, number];
  const r = (node.transform ? node.transform.rotationEulerDeg.map(toRad) : [0, 0, 0]) as [number, number, number];
  const s = (node.transform?.scale ?? [1, 1, 1]) as [number, number, number];
  const diffType = diffTypeMap ? (diffTypeMap.get(node.entityId) ?? "unchanged") : undefined;

  return (
    <group position={p} rotation={r} scale={s}>
      {node.transform !== null && (
        <EntityMesh
          node={node}
          isSelected={selectedIds.includes(node.id)}
          onSelect={onSelect}
          diffType={diffType}
        />
      )}
      {node.children.map((child) => (
        <SceneNode
          key={child.id}
          node={child}
          selectedIds={selectedIds}
          onSelect={onSelect}
          diffTypeMap={diffTypeMap}
        />
      ))}
    </group>
  );
}

// ─── public component ─────────────────────────────────────────────────────────

type Props = {
  entities: Entity[];
  constraints: Constraint[];
  selectedIds: string[];
  onSelect: (id: string) => void;
  onDeselect?: () => void;
  diffChanges?: DiffChange[] | null;
  diffMode?: boolean;
  onSelectGhost?: (entityId: string) => void;
};

export function Viewport({ entities, selectedIds, onSelect, onDeselect, diffChanges, diffMode = true, onSelectGhost }: Props) {
  const roots = useMemo(() => buildTree(entities), [entities]);

  const diffTypeMap = useMemo<Map<string, DiffChangeType> | null>(() => {
    if (!diffChanges || !diffMode) return null;
    const m = new Map<string, DiffChangeType>();
    for (const c of diffChanges) m.set(c.entityId, c.type);
    return m;
  }, [diffChanges, diffMode]);

  const removedSnaps = useMemo<DiffEntitySnapshot[]>(() => {
    if (!diffChanges) return [];
    return diffChanges
      .filter((c) => c.type === "removed" && c.before?.transform)
      .map((c) => c.before!);
  }, [diffChanges]);

  return (
    <Canvas
      shadows
      camera={{ position: [80, 80, 120], fov: 45, near: 0.1, far: 50000 }}
      gl={{ antialias: true }}
      style={{ background: "#0f172a" }}
      onPointerMissed={() => onDeselect?.()}
    >
      <ambientLight intensity={0.5} />
      <directionalLight position={[60, 120, 80]} intensity={1.4} castShadow />
      <directionalLight position={[-60, 40, -80]} intensity={0.4} />

      <Suspense fallback={null}>
        <Environment preset="city" />

        <Bounds fit clip observe damping={6} margin={1.4}>
          <group>
            {roots.map((root) => (
              <SceneNode
                key={root.id}
                node={root}
                selectedIds={selectedIds}
                onSelect={onSelect}
                diffTypeMap={diffTypeMap}
              />
            ))}
          </group>
        </Bounds>

        {/* Removed entity ghosts are outside Bounds so they don't affect camera fit */}
        {diffMode && removedSnaps.map((snap) => (
          <GhostEntity key={snap.entityId} snap={snap} onSelect={onSelectGhost} />
        ))}

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
