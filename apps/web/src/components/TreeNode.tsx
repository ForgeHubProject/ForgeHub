import { useState } from "react";
import type { Constraint, TreeNode as TreeNodeType } from "../types";

type Props = {
  node: TreeNodeType;
  constraints: Constraint[];
  selectedIds: string[];
  onSelect: (id: string) => void;
  depth?: number;
};

const KIND_ICON: Record<string, string> = {
  assembly: "▣",
  module: "◈",
  part: "◆",
};

export function TreeNode({ node, constraints, selectedIds, onSelect, depth = 0 }: Props) {
  const [expanded, setExpanded] = useState(depth < 2);

  const hasChildren = node.children.length > 0;
  const isSelected = selectedIds.includes(node.id);

  const myConstraints = constraints.filter(
    (c) => c.entityAId === node.id || c.entityBId === node.id,
  );

  const posFixed = myConstraints.some((c) => c.positionFixed);
  const rotFixed = myConstraints.some((c) => c.rotationFixed);

  return (
    <div style={{ paddingLeft: depth === 0 ? 0 : 16 }}>
      <div
        onClick={() => onSelect(node.id)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 8px",
          borderRadius: 4,
          cursor: "pointer",
          backgroundColor: isSelected ? "#dbeafe" : "transparent",
          userSelect: "none",
        }}
      >
        {/* expand toggle */}
        <span
          onClick={(e) => { e.stopPropagation(); if (hasChildren) setExpanded((v) => !v); }}
          style={{
            width: 14,
            fontSize: 10,
            color: hasChildren ? "#6b7280" : "transparent",
            cursor: hasChildren ? "pointer" : "default",
          }}
        >
          {hasChildren ? (expanded ? "▾" : "▸") : "·"}
        </span>

        {/* kind icon */}
        <span style={{ fontSize: 11, color: "#6b7280" }}>
          {KIND_ICON[node.kind] ?? "◆"}
        </span>

        {/* name */}
        <span style={{ fontSize: 13, color: "#111827", flex: 1 }}>{node.name}</span>

        {/* constraint badges */}
        <span style={{ display: "flex", gap: 2 }}>
          {posFixed && (
            <span title="Position fixed" style={badgeStyle("#3b82f6")}>P</span>
          )}
          {rotFixed && (
            <span title="Rotation fixed" style={badgeStyle("#8b5cf6")}>R</span>
          )}
        </span>
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
            />
          ))}
        </div>
      )}
    </div>
  );
}

function badgeStyle(color: string): React.CSSProperties {
  return {
    fontSize: 9,
    fontWeight: 700,
    color: "#fff",
    backgroundColor: color,
    borderRadius: 3,
    padding: "1px 4px",
    lineHeight: 1.5,
  };
}
