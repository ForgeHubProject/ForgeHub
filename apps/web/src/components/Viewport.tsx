import { Canvas } from "@react-three/fiber";
import { Bounds, GizmoHelper, GizmoViewport, Grid, OrbitControls, Text } from "@react-three/drei";
import { Suspense, useMemo } from "react";
import type { Constraint, Entity } from "../types";

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

const KIND_COLOR: Record<string, string> = {
  assembly: "#3b82f6",
  module: "#f59e0b",
  part: "#10b981",
};
const KIND_OPACITY: Record<string, number> = {
  assembly: 0.12,
  module: 0.55,
  part: 0.82,
};
const KIND_SIZE: Record<string, number> = {
  assembly: 10,
  module: 7,
  part: 4,
};

function EntityBox({
  node,
  isSelected,
  onSelect,
}: {
  node: VNode;
  isSelected: boolean;
  onSelect: (id: string) => void;
}) {
  const size = KIND_SIZE[node.kind] ?? 5;
  const color = isSelected ? "#f59e0b" : (KIND_COLOR[node.kind] ?? "#9ca3af");
  const opacity = isSelected ? 0.9 : (KIND_OPACITY[node.kind] ?? 0.5);
  const labelSize = Math.max(1.5, size * 0.38);

  return (
    <group onClick={(e) => { e.stopPropagation(); onSelect(node.id); }}>
      {/* body */}
      <mesh castShadow receiveShadow>
        <boxGeometry args={[size, size, size]} />
        <meshStandardMaterial color={color} transparent opacity={opacity} />
      </mesh>
      {/* edge outline — second pass with wireframe */}
      <mesh>
        <boxGeometry args={[size, size, size]} />
        <meshBasicMaterial color={color} wireframe transparent opacity={isSelected ? 0.9 : 0.35} />
      </mesh>
      {/* label */}
      <Text
        position={[0, size / 2 + 2, 0]}
        fontSize={labelSize}
        color={isSelected ? "#d97706" : "#1e293b"}
        anchorX="center"
        anchorY="bottom"
        outlineWidth={0.25}
        outlineColor="#ffffff"
        renderOrder={1}
      >
        {node.name}
      </Text>
    </group>
  );
}

function SceneNode({
  node,
  selectedIds,
  onSelect,
}: {
  node: VNode;
  selectedIds: string[];
  onSelect: (id: string) => void;
}) {
  const p = (node.transform?.position ?? [0, 0, 0]) as [number, number, number];
  const r = (node.transform ? node.transform.rotationEulerDeg.map(toRad) : [0, 0, 0]) as [number, number, number];
  const s = (node.transform?.scale ?? [1, 1, 1]) as [number, number, number];

  return (
    <group position={p} rotation={r} scale={s}>
      {node.transform !== null && (
        <EntityBox node={node} isSelected={selectedIds.includes(node.id)} onSelect={onSelect} />
      )}
      {node.children.map((child) => (
        <SceneNode key={child.id} node={child} selectedIds={selectedIds} onSelect={onSelect} />
      ))}
    </group>
  );
}

type Props = {
  entities: Entity[];
  constraints: Constraint[];
  selectedIds: string[];
  onSelect: (id: string) => void;
};

export function Viewport({ entities, selectedIds, onSelect }: Props) {
  const roots = useMemo(() => buildTree(entities), [entities]);

  return (
    <Canvas
      camera={{ position: [80, 80, 120], fov: 45, near: 0.1, far: 50000 }}
      style={{ background: "#f1f5f9" }}
      shadows
    >
      <ambientLight intensity={0.7} />
      <directionalLight position={[100, 200, 100]} intensity={1.2} castShadow />
      <directionalLight position={[-100, 50, -100]} intensity={0.3} />

      <Suspense fallback={null}>
        <Bounds fit clip observe damping={6} margin={1.4}>
          <group>
            {roots.map((root) => (
              <SceneNode key={root.id} node={root} selectedIds={selectedIds} onSelect={onSelect} />
            ))}
          </group>
        </Bounds>

        <Grid
          args={[500, 500]}
          position={[0, -2, 0]}
          cellSize={5}
          cellThickness={0.5}
          cellColor="#cbd5e1"
          sectionSize={25}
          sectionThickness={1}
          sectionColor="#94a3b8"
          fadeDistance={400}
          fadeStrength={1}
          followCamera={false}
          infiniteGrid
        />
      </Suspense>

      <OrbitControls makeDefault enablePan enableZoom enableRotate />

      <GizmoHelper alignment="bottom-right" margin={[70, 70]}>
        <GizmoViewport axisColors={["#ef4444", "#22c55e", "#3b82f6"]} labelColor="#111827" />
      </GizmoHelper>
    </Canvas>
  );
}
