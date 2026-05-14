import type { CSSProperties } from "react";
import { useState } from "react";
import type { Constraint, DiffChangeType, TreeNode as TreeNodeType } from "../types";

type Props = {
  node: TreeNodeType;
  constraints: Constraint[];
  selectedIds: string[];
  onSelect?: (id: string) => void;
  depth?: number;
  diffTypeByEntityId?: Map<string, DiffChangeType> | null;
};

const DIFF_TREE_ACCENT: Record<Exclude<DiffChangeType, "unchanged">, string> = {
  added: "#22c55e",
  removed: "#ef4444",
  modified: "#64748b",
  moved: "#6366f1",
};

const KIND_ICON: Record<string, string> = {
  assembly: "▣",
  module: "◈",
  part: "◆",
};

export function TreeNode({ node, constraints, selectedIds, onSelect, depth = 0, diffTypeByEntityId }: Props) {
  const [expanded, setExpanded] = useState(depth < 2);
  const [hovered, setHovered] = useState(false);

  const hasChildren = node.children.length > 0;
  const isSelected = selectedIds.includes(node.id);
  const diffType = diffTypeByEntityId?.get(node.entityId);
  const diffAccent =
    diffType && diffType !== "unchanged" ? DIFF_TREE_ACCENT[diffType as Exclude<DiffChangeType, "unchanged">] : undefined;

  const myConstraints = constraints.filter(
    (c) => c.entityAId === node.id || c.entityBId === node.id,
  );
  const posFixed = myConstraints.some((c) => c.positionFixed);
  const rotFixed = myConstraints.some((c) => c.rotationFixed);

  return (
    <div style={{ paddingLeft: depth === 0 ? 0 : 16 }}>
      <div
        onClick={() => onSelect?.(node.id)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 8px",
          borderRadius: 4,
          cursor: onSelect ? "pointer" : "default",
          backgroundColor: isSelected ? "#dbeafe" : hovered ? "#f9fafb" : "transparent",
          userSelect: "none",
          borderLeft: diffAccent ? `3px solid ${diffAccent}` : undefined,
          marginLeft: diffAccent ? -1 : undefined,
        }}
      >
        <span
          onClick={(e) => { e.stopPropagation(); if (hasChildren) setExpanded((v) => !v); }}
          style={{
            width: 14, fontSize: 10,
            color: hasChildren ? "#6b7280" : "transparent",
            cursor: hasChildren ? "pointer" : "default",
          }}
        >
          {hasChildren ? (expanded ? "▾" : "▸") : "·"}
        </span>

        <span style={{ fontSize: 11, color: "#6b7280" }}>
          {KIND_ICON[node.kind] ?? "◆"}
        </span>

        <span style={{ fontSize: 13, color: "#111827", flex: 1 }}>{node.name}</span>

        {posFixed && <span title="Position fixed" style={badgeStyle("#3b82f6")}>P</span>}
        {rotFixed && <span title="Rotation fixed" style={badgeStyle("#8b5cf6")}>R</span>}
      </div>

      {hasChildren && expanded && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              constraints={constraints}
              selectedIds={selectedIds}
              onSelect={onSelect}
              depth={depth + 1}
              diffTypeByEntityId={diffTypeByEntityId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function badgeStyle(color: string): CSSProperties {
  return {
    fontSize: 9, fontWeight: 700, color: "#fff",
    backgroundColor: color, borderRadius: 3,
    padding: "1px 4px", lineHeight: 1.5,
  };
}
