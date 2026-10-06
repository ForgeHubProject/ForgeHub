#!/usr/bin/env bash
# Build and push ForgeHub container images (sqlite, postgres, mysql) to
# docker.io, ghcr.io and quay.io, tagged <BASE>-<N> and latest.
#
# <N> auto-increments: the highest existing "<BASE>-<N>" tag across all three
# registries, plus one. Assumes you are already logged in to each registry.
#
# Usage:
#   scripts/release-containers.sh                 # next patch of BASE (default 1.0)
#   BASE=1.1 scripts/release-containers.sh        # start/continue a new base
#   scripts/release-containers.sh --dry-run       # print plan, build nothing
#   scripts/release-containers.sh --local         # build locally only (host arch), no push
#   Push preflight (skipped for --dry-run/--local): clean tree (ALLOW_DIRTY=1), HEAD on a
#   remote branch (ALLOW_UNPUSHED=1), version tags not already published.
#   PLATFORMS=linux/amd64 scripts/release-containers.sh   # single arch (faster)
#   REGISTRIES="docker.io/x/forgehub ghcr.io/y/forgehub" scripts/release-containers.sh
set -euo pipefail

BASE="${BASE:-1.0}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
REGISTRIES="${REGISTRIES:-docker.io/touficmajdalani/forgehub ghcr.io/forgehubproject/forgehub quay.io/forgehubproject/forgehub}"
DRY_RUN=0 LOCAL=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --local)   LOCAL=1 ;;   # build for this host only, load into local docker, no push
    *) echo "unknown arg: $a" >&2; exit 1 ;;
  esac
done

cd "$(dirname "$0")/.."

# Auto-install missing host tools (curl+jq list remote tags, buildx builds multi-arch).
need() { command -v "$1" >/dev/null 2>&1; }
install_pkg() {
  if   need pacman;  then sudo pacman -S --needed --noconfirm "$@"
  elif need apt-get; then sudo apt-get install -y "$@"
  elif need dnf;     then sudo dnf install -y "$@"
  elif need zypper;  then sudo zypper install -y "$@"
  else echo "no supported package manager to install: $*" >&2; exit 1; fi
}
need docker  || { echo "docker required" >&2; exit 1; }
need curl || install_pkg curl
need jq   || install_pkg jq
docker buildx version >/dev/null 2>&1 || install_pkg docker-buildx
(( DRY_RUN || LOCAL )) || need qemu-aarch64-static || [[ "$PLATFORMS" != *arm64* ]] || docker run --privileged --rm tonistiigi/binfmt --install arm64 >/dev/null

# List tags of a public repo via the registry HTTP API (empty if repo missing/private).
list_tags() {
  local reg="${1%%/*}" repo="${1#*/}" tok
  case "$reg" in
    docker.io)
      tok="$(curl -fsS "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$repo:pull" | jq -r .token)" || return 0
      curl -fsS -H "Authorization: Bearer $tok" "https://registry-1.docker.io/v2/$repo/tags/list" | jq -r '.tags[]?' ;;
    ghcr.io|quay.io)
      tok="$(curl -fsS "https://$reg/token?service=$reg&scope=repository:$repo:pull" | jq -r '.token // empty')" || tok=""
      curl -fsS ${tok:+-H "Authorization: Bearer $tok"} "https://$reg/v2/$repo/tags/list?n=1000" | jq -r '.tags[]?' ;;
  esac 2>/dev/null || true
}

# Next N = 1 + max N seen for BASE-N on any registry (empty/missing repo → 0).
max_n=0
for reg in $REGISTRIES; do
  while read -r t; do
    [[ "$t" =~ ^${BASE//./\\.}-([0-9]+)$ ]] || continue
    (( BASH_REMATCH[1] > max_n )) && max_n=${BASH_REMATCH[1]}
  done < <(list_tags "$reg")
done
VERSION="${BASE}-$((max_n + 1))"
VCS_REF="$(git rev-parse --short HEAD)"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "Release: $VERSION (+ latest) from $VCS_REF"
echo "Registries: $REGISTRIES"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  if (( DRY_RUN || LOCAL )); then
    echo "warning: working tree has uncommitted changes; image will include them" >&2
  elif [[ "${ALLOW_DIRTY:-0}" != 1 ]]; then
    echo "error: uncommitted changes would be baked into a pushed image (commit them, or ALLOW_DIRTY=1)" >&2
    exit 1
  fi
fi

# Pushed images are labelled with VCS_REF; it must exist on a remote or the label is unverifiable.
if (( ! DRY_RUN && ! LOCAL )) && [[ "${ALLOW_UNPUSHED:-0}" != 1 ]] \
   && [[ -z "$(git branch -r --contains HEAD 2>/dev/null)" ]]; then
  echo "error: HEAD ($VCS_REF) is not on any remote branch (git push first, or ALLOW_UNPUSHED=1)" >&2
  exit 1
fi

# Never overwrite an already-published version tag (guards races and failed tag listings).
if (( ! DRY_RUN && ! LOCAL )); then
  for reg in $REGISTRIES; do
    for suffix in "" -postgres -mysql; do
      if docker buildx imagetools inspect "$reg:${VERSION}${suffix}" >/dev/null 2>&1; then
        echo "error: $reg:${VERSION}${suffix} already exists; refusing to overwrite" >&2
        exit 1
      fi
    done
  done
fi

# provider:suffix:build-url (mirrors .github/workflows/publish.yml matrix)
VARIANTS=(
  "sqlite::file:/tmp/.build-dummy.db"
  "postgresql:-postgres:postgresql://user:pass@localhost:5432/forgehub"
  "mysql:-mysql:mysql://user:pass@localhost:3306/forgehub"
)

if (( ! DRY_RUN && ! LOCAL )); then
  docker buildx inspect forgehub-release >/dev/null 2>&1 || docker buildx create --name forgehub-release --use >/dev/null
  docker buildx use forgehub-release
fi

for v in "${VARIANTS[@]}"; do
  provider="${v%%:*}"; rest="${v#*:}"; suffix="${rest%%:*}"; url="${rest#*:}"
  tag_args=()
  for reg in $REGISTRIES; do
    tag_args+=(-t "$reg:${VERSION}${suffix}" -t "$reg:latest${suffix}")
  done
  echo "==> $provider  (${VERSION}${suffix}, latest${suffix})"
  if (( LOCAL )); then out=(--load); plat=(); else out=(--push); plat=(--platform "$PLATFORMS"); fi
  cmd=(docker buildx build "${plat[@]}" --file Dockerfile
       --build-arg "DATABASE_PROVIDER=$provider" --build-arg "DATABASE_URL_BUILD=$url"
       --build-arg "BUILD_DATE=$BUILD_DATE" --build-arg "VCS_REF=$VCS_REF" --build-arg "VERSION=$VERSION"
       "${tag_args[@]}" "${out[@]}" .)
  if (( DRY_RUN )); then printf '    %q ' "${cmd[@]}"; echo; else "${cmd[@]}"; fi
done

echo "Done: $VERSION"
