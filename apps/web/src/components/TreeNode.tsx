import { useState } from "react";
import type { Constraint, TreeNode as TreeNodeType } from "../types";

type Props = {
  node: TreeNodeType;
  constraints: Constraint[];
  selectedIds: string[];
  onSelect: (id: string, multi: boolean) => void;
  onDelete: (id: string) => void;
  depth?: number;
};

const KIND_ICON: Record<string, string> = {
  assembly: "▣",
  module: "◈",
  part: "◆",
};

export function TreeNode({ node, constraints, selectedIds, onSelect, onDelete, depth = 0 }: Props) {
  const [expanded, setExpanded] = useState(depth < 2);
  const [hovered, setHovered] = useState(false);

  const hasChildren = node.children.length > 0;
  const isSelected = selectedIds.includes(node.id);
  const isRoot = !node.parentEntityId;

  const myConstraints = constraints.filter(
    (c) => c.entityAId === node.id || c.entityBId === node.id,
  );
  const posFixed = myConstraints.some((c) => c.positionFixed);
  const rotFixed = myConstraints.some((c) => c.rotationFixed);

  return (
    <div style={{ paddingLeft: depth === 0 ? 0 : 16 }}>
      <div
        onClick={(e) => onSelect(node.id, e.shiftKey)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 8px",
          borderRadius: 4,
          cursor: "pointer",
          backgroundColor: isSelected ? "#dbeafe" : hovered ? "#f9fafb" : "transparent",
          userSelect: "none",
        }}
      >
        {/* expand toggle */}
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

        {/* kind icon */}
        <span style={{ fontSize: 11, color: "#6b7280" }}>
          {KIND_ICON[node.kind] ?? "◆"}
        </span>

        {/* name */}
        <span style={{ fontSize: 13, color: "#111827", flex: 1 }}>{node.name}</span>

        {/* constraint badges */}
        {posFixed && <span title="Position fixed" style={badgeStyle("#3b82f6")}>P</span>}
        {rotFixed && <span title="Rotation fixed" style={badgeStyle("#8b5cf6")}>R</span>}

        {/* delete button — appears on hover */}
        {hovered && (
          <button
            title={isRoot ? "Delete snapshot" : "Delete entity"}
            onClick={(e) => { e.stopPropagation(); onDelete(node.id); }}
            style={{
              fontSize: 11, lineHeight: 1,
              color: isRoot ? "#ef4444" : "#9ca3af",
              background: "none", border: "none", cursor: "pointer",
              padding: "1px 3px", borderRadius: 3,
              marginLeft: 2,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "#ef4444"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = isRoot ? "#ef4444" : "#9ca3af"; }}
          >
            ✕
          </button>
        )}
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
              onDelete={onDelete}
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
    fontSize: 9, fontWeight: 700, color: "#fff",
    backgroundColor: color, borderRadius: 3,
    padding: "1px 4px", lineHeight: 1.5,
  };
}
