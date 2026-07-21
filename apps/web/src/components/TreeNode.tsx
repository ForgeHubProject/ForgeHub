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
  added: "rgb(var(--fh-success-emphasis))",
  removed: "rgb(var(--fh-danger-emphasis))",
  modified: "rgb(var(--fh-warning-emphasis))",
  moved: "rgb(var(--fh-purple-emphasis))",
};

const DIFF_TREE_ICON: Record<Exclude<DiffChangeType, "unchanged">, string> = {
  added: "+",
  removed: "−",
  modified: "~",
  moved: "↔",
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
          backgroundColor: isSelected
            ? "rgb(var(--fh-accent-muted))"
            : hovered
            ? "rgb(var(--fh-surface-muted))"
            : "transparent",
          userSelect: "none",
          boxShadow: diffAccent ? `inset 4px 0 0 0 ${diffAccent}` : undefined,
        }}
      >
        <span
          onClick={(e) => { e.stopPropagation(); if (hasChildren) setExpanded((v) => !v); }}
          style={{
            width: 14, fontSize: 10,
            color: hasChildren ? "rgb(var(--fh-fg-subtle))" : "transparent",
            cursor: hasChildren ? "pointer" : "default",
          }}
        >
          {hasChildren ? (expanded ? "▾" : "▸") : "·"}
        </span>

        <span style={{ fontSize: 11, color: "rgb(var(--fh-fg-subtle))" }}>
          {KIND_ICON[node.kind] ?? "◆"}
        </span>

        <span
          style={{
            fontSize: 13,
            color: "rgb(var(--fh-fg))",
            flex: 1,
            fontWeight: diffAccent ? 600 : 400,
          }}
        >
          {node.name}
        </span>

        {diffAccent && diffType && diffType !== "unchanged" && (
          <span
            title={`Diff: ${diffType}`}
            style={{
              fontSize: 9,
              fontWeight: 800,
              color: "rgb(var(--fh-on-emphasis))",
              backgroundColor: diffAccent,
              borderRadius: 4,
              padding: "2px 6px",
              lineHeight: 1.2,
              flexShrink: 0,
            }}
          >
            {DIFF_TREE_ICON[diffType as Exclude<DiffChangeType, "unchanged">]}
          </span>
        )}

        {posFixed && <span title="Position fixed" style={badgeStyle("rgb(var(--fh-accent-emphasis))")}>P</span>}
        {rotFixed && <span title="Rotation fixed" style={badgeStyle("rgb(var(--fh-purple-emphasis))")}>R</span>}
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
    fontSize: 9, fontWeight: 700, color: "rgb(var(--fh-on-emphasis))",
    backgroundColor: color, borderRadius: 3,
    padding: "1px 4px", lineHeight: 1.5,
  };
}
