import type { Constraint, DiffChangeType, Entity, TreeNode as TreeNodeType } from "../types";
import { TreeNode } from "./TreeNode";

function buildTree(entities: Entity[]): TreeNodeType[] {
  const map = new Map<string, TreeNodeType>();
  for (const e of entities) map.set(e.id, { ...e, children: [] });

  const roots: TreeNodeType[] = [];
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

type Props = {
  entities: Entity[];
  constraints: Constraint[];
  selectedIds: string[];
  onSelect?: (id: string) => void;
  /** When diff mode is on, highlights rows whose `entityId` has a non-unchanged change. */
  diffTypeByEntityId?: Map<string, DiffChangeType> | null;
};

export function ModuleTree({ entities, constraints, selectedIds, onSelect, diffTypeByEntityId }: Props) {
  const roots = buildTree(entities);

  if (roots.length === 0) {
    return <div style={{ padding: 16, color: "#6b7280", fontSize: 13 }}>No entities found.</div>;
  }

  return (
    <div style={{ padding: "4px 0" }}>
      {roots.map((root) => (
        <TreeNode
          key={root.id}
          node={root}
          constraints={constraints}
          selectedIds={selectedIds}
          onSelect={onSelect}
          diffTypeByEntityId={diffTypeByEntityId}
        />
      ))}
    </div>
  );
}
