# Forge

> Git, but for everything.

Forge is a format-aware version control system built on top of libgit2. It stays fully git-compatible for storage and transport, but replaces git's text-only diff and merge layer with a handler plugin system that any file format can implement.

The result: semantic diffs and 3-way merges for 3D models, images, audio, CAD files, or any proprietary format — not just text.

---

## The Problem

Git's object store is format-agnostic — it stores any file as a blob. But git's diff and merge logic is line-based text only. For everything else:

- `git diff model.glb` → *"Binary files differ"*
- `git merge` on a `.psd` conflict → pick a side, lose information
- No understanding of what actually changed inside the file

Existing solutions (Git LFS, Perforce, Plastic SCM) solve the storage problem but not the semantic problem. You can store a 10GB `.uasset` in LFS, but you still can't see what changed in it or merge two versions intelligently.

---

## The Vision

```
forge diff character.glb       → which bones moved, which materials changed
forge merge scene.glb          → 3-way merge at the scene-graph level
forge log environment.hdr      → per-version thumbnails and metadata
forge push / forge pull        → identical to git, fully compatible
```

Any git host (including ForgeHub) works out of the box. Forge repos are git repos.

---

## Architecture

```
┌─────────────────────────────────────────┐
│               Forge CLI                  │
│  forge diff · forge merge · forge log   │
├─────────────────────────────────────────┤
│           Handler Registry              │  ← resolves handler by file path/ext
├──────────┬──────────┬───────────────────┤
│  Text    │  glTF    │  Community …      │  ← ForgeHandler implementations
│ Handler  │ Handler  │  .psd .svg .blend │
├─────────────────────────────────────────┤
│              libgit2 (MIT)              │  ← storage, transport, refs, DAG
│   commits · trees · blobs · push/pull  │
└─────────────────────────────────────────┘
```

**libgit2** is used instead of submoduling git's C source directly. It exposes the full git object model under an MIT license, with bindings for Go, Rust, Python, Node, and others. Forge repos are standard git repos — any git host works.

---

## The ForgeHandler Interface

This is the core abstraction. Keep it minimal so the ecosystem can adopt it.

```go
// ForgeHandler implements format-aware diff and merge for one file type.
type ForgeHandler interface {
    // Match returns true if this handler should process the given file path.
    Match(path string) bool

    // Diff produces a structured, semantic diff between two blobs.
    // The result can be rendered by a viewer (CLI, web, IDE).
    Diff(base, head Blob) (StructuredDiff, error)

    // Merge attempts a 3-way merge.
    // Returns the merged blob on success, or ConflictInfo describing
    // which semantic units could not be reconciled.
    Merge(base, ours, theirs Blob) (Blob, *ConflictInfo, error)
}
```

A handler that cannot implement `Merge` may return `ErrNotSupported` — Forge falls back to "pick a side" (the same as plain git today). `Diff` alone is already a massive improvement over "Binary files differ."

### Supporting types

```go
type Blob []byte

// StructuredDiff is a tree of semantic changes.
// Each node represents a meaningful unit in the format's domain
// (a line, a scene-graph node, a layer, a channel, etc.)
type StructuredDiff struct {
    Format  string       // e.g. "gltf", "text", "psd"
    Changes []DiffChange
}

type DiffChange struct {
    Path   string      // semantic path, e.g. "nodes[2].translation"
    Kind   ChangeKind  // Added | Removed | Modified
    Before any
    After  any
}

type ConflictInfo struct {
    Conflicts []SemanticConflict
}

type SemanticConflict struct {
    Path  string  // where the conflict is
    Ours  any
    Theirs any
}
```

---

## Handler Domains

Handlers can operate at different levels of abstraction. A high-level domain handler covers a broad class; a low-level one targets a specific format. Both implement the same interface.

```
Domain level    Example handler         Covers
─────────────────────────────────────────────────────────────
High (broad)    3DHandler               any 3D format (fallback)
Mid             GltfHandler             .glb, .gltf
Mid             ObjHandler              .obj + .mtl
Low (specific)  BlenderHandler          .blend (via Blender's Python API)

High            RasterImageHandler      any image (pixel diff)
Mid             PsdHandler              .psd (layer-aware diff/merge)

High            TextHandler             any text (ships with Forge)
Mid             JsonHandler             .json (key-path aware diff)
Low             PackageJsonHandler      package.json (dep-aware merge)
```

The registry walks from most-specific to least-specific and uses the first matching handler. Community handlers can insert at any level.

---

## Handler Resolution

```
forge diff src/scene.glb
  → registry.Resolve("src/scene.glb")
  → [BlenderHandler✗, GltfHandler✓]  ← first match wins
  → GltfHandler.Diff(base, head)
  → renders structured diff
```

If no handler matches, Forge falls back to git's built-in binary diff (same as today, no regression).

---

## Community Handler Ecosystem

The goal is thousands of community-maintained handlers, following the same model as:

- **Tree-sitter** — any language's grammar in one interface
- **LSP** — any language's IDE features in one protocol  
- **Prettier plugins** — any file format, one formatter interface

A handler is a small package that:
1. Implements `ForgeHandler`
2. Declares which file patterns it handles (`*.glb`, `*.psd`, `*.usd`, etc.)
3. Is registered in a central handler registry (or loaded locally via config)

Proprietary formats are solved at the handler level, not by Forge itself. A `.blend` handler uses Blender's Python API. A `.ptex` handler uses NVIDIA's open-source library. Forge stays clean and format-agnostic.

---

## Relationship to ForgeHub

ForgeHub is the web hosting platform for Forge repos. The handler abstraction appears in both layers:

| Layer | Interface | Used for |
|-------|-----------|----------|
| Forge CLI | `ForgeHandler` | diff, merge, conflict resolution |
| ForgeHub web | `FileDiffViewer` | rendering diffs in the browser |
| ForgeHub web | `FileViewer` | rendering blobs in the browser |

A glTF handler in the CLI produces a `StructuredDiff`. ForgeHub's `GltfDiffViewer` renders that diff in the browser — the same data, different presentation layer. Long-term, a handler package could ship both the CLI logic and the web renderer.

---

## Milestones

### M0 — Spec (now)
- [ ] Finalize `ForgeHandler` interface
- [ ] Decide implementation language (Go + git2go recommended)
- [ ] Define `StructuredDiff` wire format (JSON schema)

### M1 — Core + TextHandler
- [ ] Forge CLI skeleton (`forge diff`, `forge merge`, `forge log`, `forge push`, `forge pull`)
- [ ] libgit2 integration via language binding
- [ ] `TextHandler` — wraps libgit2's built-in line diff (establishes baseline, no regression vs git)
- [ ] Handler registry with path-pattern matching

### M2 — First non-text handler (GltfHandler)
- [ ] Parse glTF/GLB scene graph into semantic representation
- [ ] `GltfHandler.Diff()` — node/mesh/material-level diff
- [ ] `forge diff model.glb` produces human-readable scene diff
- [ ] ForgeHub renders the diff (already has viewer registry)
- [ ] `GltfHandler.Merge()` — non-overlapping node changes merge cleanly

### M3 — Conflict UX
- [ ] Define conflict marker format for non-text formats
- [ ] `forge mergetool` dispatches to handler-specific resolution UI
- [ ] CLI conflict resolution for text (identical to git)
- [ ] ForgeHub conflict resolution UI for glTF

### M4 — Community SDK
- [ ] Published `ForgeHandler` interface as a standalone package
- [ ] Handler registry server (discover and install community handlers)
- [ ] Documentation and example handler template
- [ ] `forge handler install gltf` / `forge handler list`

---

## Key Technical Decisions

**Language: Go**  
Natural fit for a CLI tool, excellent libgit2 bindings (`git2go`), strong concurrency, single-binary distribution.

**Storage: libgit2, not forked git**  
libgit2 is MIT licensed and exposes the full git object model as a C library with bindings in every language. Forge repos are 100% standard git repos — any existing git host works.

**Wire format: JSON for StructuredDiff**  
Human-readable, language-agnostic, easy to render in web UIs (ForgeHub). Handlers can embed binary data (base64) for thumbnails or preview frames.

**Handler loading: plugins via shared library or subprocess**  
Handlers can be compiled into Forge (built-in) or loaded as external processes via a simple stdin/stdout protocol — same pattern as LSP. This allows community handlers in any language.

---

## Open Questions

1. **Semantic merge correctness** — for complex formats (skeletal animation, shader graphs), what is the "correct" merge when both sides modify the same semantic unit? This may require handler-defined conflict resolution strategies, not a single universal answer.

2. **Storage efficiency** — git's delta compression works on raw bytes. A glTF handler that reserializes the file on every operation may produce larger packfiles. Handlers may need a `Serialize(canonical bool)` method to produce stable byte output.

3. **Forge vs git interoperability** — a plain `git diff model.glb` from someone without Forge should still work (returns binary diff). Forge-specific metadata (handler hints, structured diff cache) lives in git notes or a `.forge` config file, not in the object store.

4. **Handler trust model** — community handlers run code on the user's machine. A sandboxing or signature model is needed before `forge handler install` is safe at scale.
