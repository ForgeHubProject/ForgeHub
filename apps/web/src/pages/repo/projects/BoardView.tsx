import { useMemo, useRef, useState } from "react";
import {
  Button, DropdownMenu, DropdownItem, DropdownSeparator, TextInput, cx,
} from "../../../ui";
import type { ProjectColumn, ProjectSubjectType } from "../../../types";
import { ItemCard } from "./ItemCard";
import { AddItemPicker } from "./AddItemPicker";
import { KebabIcon, PencilIcon, PlusIcon, TrashIcon } from "./parts";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  base: string;
  projectNumber: number;
  columns: ProjectColumn[];
  canWrite: boolean;
  onMoveItem: (itemId: string, destColumnId: string, index: number) => void;
  onAddItem: (columnId: string, type: ProjectSubjectType, number: number) => Promise<void>;
  onRemoveItem: (itemId: string) => void;
  onAddColumn: (name: string) => Promise<void>;
  onRenameColumn: (columnId: string, name: string) => Promise<void>;
  onDeleteColumn: (columnId: string) => void;
  onReorderColumns: (order: string[]) => void;
};

/** Index at which the dragged card would land among a column's non-dragging cards. */
function dropIndexFor(container: HTMLElement, clientY: number, draggingId: string | null): number {
  const cards = Array.from(container.querySelectorAll<HTMLElement>("[data-item-id]")).filter(
    (el) => el.dataset["itemId"] !== draggingId,
  );
  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i]!.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return i;
  }
  return cards.length;
}

export function BoardView(props: Props) {
  const { columns, canWrite } = props;
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ columnId: string; index: number } | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);

  const excludeKeys = useMemo(() => {
    const s = new Set<string>();
    for (const col of columns) for (const it of col.items) s.add(`${it.subjectType}:${it.subjectNumber}`);
    return s;
  }, [columns]);

  return (
    <div className="flex gap-4 overflow-x-auto pb-4 items-start">
      {columns.map((column, colIndex) => (
        <Column
          key={column.id}
          column={column}
          colIndex={colIndex}
          columnCount={columns.length}
          allColumns={columns}
          draggingId={draggingId}
          dropTarget={dropTarget}
          setDropTarget={setDropTarget}
          setDraggingId={setDraggingId}
          {...props}
          excludeKeys={excludeKeys}
        />
      ))}

      {canWrite && (
        <div className="shrink-0 w-72">
          {addingColumn ? (
            <NewColumnForm
              onCancel={() => setAddingColumn(false)}
              onCreate={async (name) => {
                await props.onAddColumn(name);
                setAddingColumn(false);
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setAddingColumn(true)}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-md border border-dashed border-fh-border px-3 py-2.5 text-fh-sm text-fh-fg-muted hover:border-fh-border-strong hover:text-fh-fg hover:bg-fh-surface-muted outline-none focus-visible:ring-2 focus-visible:ring-fh-accent-emphasis"
            >
              <PlusIcon size={14} /> New column
            </button>
          )}
        </div>
      )}
    </div>
  );
}

type ColumnProps = Props & {
  column: ProjectColumn;
  colIndex: number;
  columnCount: number;
  allColumns: ProjectColumn[];
  draggingId: string | null;
  dropTarget: { columnId: string; index: number } | null;
  setDropTarget: (t: { columnId: string; index: number } | null) => void;
  setDraggingId: (id: string | null) => void;
  excludeKeys: Set<string>;
};

function Column({
  column, colIndex, columnCount, allColumns, draggingId, dropTarget, setDropTarget, setDraggingId,
  base, canWrite, token, handle, repoName, excludeKeys,
  onMoveItem, onAddItem, onRemoveItem, onRenameColumn, onDeleteColumn, onReorderColumns,
}: ColumnProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState(false);
  const isDropTarget = dropTarget?.columnId === column.id;

  function moveColumn(dir: -1 | 1) {
    const order = allColumns.map((c) => c.id);
    const from = colIndex;
    const to = from + dir;
    if (to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to]!, order[from]!];
    onReorderColumns(order);
  }

  function handleDragOver(e: React.DragEvent) {
    if (!draggingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (listRef.current) {
      const index = dropIndexFor(listRef.current, e.clientY, draggingId);
      if (dropTarget?.columnId !== column.id || dropTarget.index !== index) {
        setDropTarget({ columnId: column.id, index });
      }
    }
  }

  function handleDrop(e: React.DragEvent) {
    if (!draggingId || !listRef.current) return;
    e.preventDefault();
    const index = dropIndexFor(listRef.current, e.clientY, draggingId);
    onMoveItem(draggingId, column.id, index);
    setDraggingId(null);
    setDropTarget(null);
  }

  // Render cards with an insertion indicator among non-dragging cards.
  let nonDragSeen = 0;
  const indicator = (
    <div className="h-0.5 rounded-full bg-fh-accent-emphasis my-1" aria-hidden="true" />
  );

  return (
    <section
      className={cx(
        "shrink-0 w-72 flex flex-col rounded-md border bg-fh-surface-muted/60",
        isDropTarget ? "border-fh-accent-emphasis" : "border-fh-border",
      )}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      aria-label={`${column.name} column`}
    >
      <header className="flex items-center gap-2 px-3 py-2 border-b border-fh-border">
        {renaming ? (
          <InlineRename
            initial={column.name}
            onCancel={() => setRenaming(false)}
            onSave={async (name) => {
              await onRenameColumn(column.id, name);
              setRenaming(false);
            }}
          />
        ) : (
          <>
            <h3 className="min-w-0 flex-1 truncate text-fh-sm font-semibold text-fh-fg">{column.name}</h3>
            <span className="shrink-0 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-fh-neutral-muted text-fh-xs font-semibold text-fh-fg-muted">
              {column.items.length}
            </span>
            {canWrite && (
              <DropdownMenu
                align="end"
                trigger={
                  <button
                    type="button"
                    aria-label={`${column.name} column actions`}
                    className="shrink-0 inline-flex items-center justify-center h-6 w-6 rounded-md text-fh-fg-muted hover:bg-fh-surface-muted hover:text-fh-fg outline-none focus-visible:ring-2 focus-visible:ring-fh-accent-emphasis"
                  >
                    <KebabIcon size={16} />
                  </button>
                }
              >
                <DropdownItem leadingIcon={<PencilIcon size={14} />} onSelect={() => setRenaming(true)}>Rename</DropdownItem>
                <DropdownItem onSelect={() => moveColumn(-1)} disabled={colIndex === 0}>Move left</DropdownItem>
                <DropdownItem onSelect={() => moveColumn(1)} disabled={colIndex === columnCount - 1}>Move right</DropdownItem>
                <DropdownSeparator />
                <DropdownItem
                  danger
                  leadingIcon={<TrashIcon size={14} />}
                  disabled={column.items.length > 0}
                  onSelect={() => onDeleteColumn(column.id)}
                >
                  Delete column
                </DropdownItem>
              </DropdownMenu>
            )}
          </>
        )}
      </header>

      <div ref={listRef} className="flex-1 min-h-[60px] p-2 flex flex-col gap-2">
        {column.items.map((item) => {
          const showBefore = isDropTarget && dropTarget!.index === nonDragSeen && item.id !== draggingId;
          if (item.id !== draggingId) nonDragSeen++;
          return (
            <div key={item.id}>
              {showBefore && indicator}
              <ItemCard
                item={item}
                base={base}
                columns={allColumns}
                currentColumnId={column.id}
                canWrite={canWrite}
                dragging={draggingId === item.id}
                onDragStart={() => setDraggingId(item.id)}
                onDragEnd={() => { setDraggingId(null); setDropTarget(null); }}
                onMoveToColumn={(destColumnId) => {
                  const dest = allColumns.find((c) => c.id === destColumnId);
                  onMoveItem(item.id, destColumnId, dest ? dest.items.length : 0);
                }}
                onRemove={() => onRemoveItem(item.id)}
              />
            </div>
          );
        })}
        {/* Trailing indicator when dropping at the very end. */}
        {isDropTarget && dropTarget!.index >= nonDragSeen && indicator}

        {column.items.length === 0 && !isDropTarget && (
          <p className="px-1 py-4 text-center text-fh-xs text-fh-fg-subtle">No items</p>
        )}
      </div>

      {canWrite && (
        <div className="px-2 pb-2">
          <AddItemPicker
            token={token}
            handle={handle}
            repoName={repoName}
            excludeKeys={excludeKeys}
            onAdd={(type, number) => onAddItem(column.id, type, number)}
          />
        </div>
      )}
    </section>
  );
}

function InlineRename({ initial, onSave, onCancel }: { initial: string; onSave: (name: string) => Promise<void>; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  async function commit() {
    const name = value.trim();
    if (!name || name === initial) return onCancel();
    setBusy(true);
    try { await onSave(name); } finally { setBusy(false); }
  }
  return (
    <div className="flex-1">
      <TextInput
        sizing="sm"
        autoFocus
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); void commit(); }
          if (e.key === "Escape") onCancel();
        }}
      />
    </div>
  );
}

function NewColumnForm({ onCreate, onCancel }: { onCreate: (name: string) => Promise<void>; onCancel: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    const name = value.trim();
    if (!name) return;
    setBusy(true);
    try { await onCreate(name); } finally { setBusy(false); }
  }
  return (
    <div className="rounded-md border border-fh-border bg-fh-surface p-2">
      <TextInput
        sizing="sm"
        autoFocus
        value={value}
        placeholder="Column name"
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); void submit(); }
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" variant="primary" loading={busy} onClick={submit}>Add</Button>
        <Button size="sm" variant="invisible" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
