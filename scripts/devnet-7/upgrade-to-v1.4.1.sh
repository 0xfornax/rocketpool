#!/usr/bin/env bash
# Compile v1.4.1-dev in a side worktree and execute RocketUpgradeOneDotFourDotOne
# against a live 1.4.0 (master) Kurtosis deploy.
#
# Prerequisites: guardian bootstrap still open; deployments/latest.json from the
# 1.4.0 deploy; EL RPC reachable.
#
# Usage:
#   ./scripts/devnet-7/upgrade-to-v1.4.1.sh
#   PROVIDER_URL=http://127.0.0.1:32003 ./scripts/devnet-7/upgrade-to-v1.4.1.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=kurtosis-ports.env
source "${SCRIPT_DIR}/kurtosis-ports.env"

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

PROVIDER_URL="${PROVIDER_URL:-${EL_HTTP:-$KURTOSIS_EL_HTTP_DEFAULT}}"
PRIVATE_KEY="${PRIVATE_KEY:-0xbcdf20249abf0ed6d944c0288fad489e33f66b3960d9e6229c1cd214ed3bbe31}"
V141_WORKDIR="${V141_WORKDIR:-${ROOT_DIR}/.devnet-v141}"
V141_REF="${V141_REF:-v1.4.1-dev}"
NETWORK_PARAMS="${SCRIPT_DIR}/network_params.yaml"
CL_HTTP="${CL_HTTP:-$KURTOSIS_CL_HTTP_DEFAULT}"

[[ -f "${ROOT_DIR}/deployments/latest.json" ]] || die "missing deployments/latest.json"

# Gloas slot for v1.4.1 BSV (7 fork slots). Default matches network_params.yaml.
spe=32
ge="$(sed -nE 's/^[[:space:]]*gloas_fork_epoch:[[:space:]]*([0-9]+).*/\1/p' "$NETWORK_PARAMS" 2>/dev/null | head -n1)"
if [[ -n "${CL_HTTP}" ]]; then
    if sj="$(curl -sf --max-time 5 "${CL_HTTP}/eth/v1/config/spec" 2>/dev/null)"; then
        vg="$(printf '%s' "$sj" | sed -nE 's/.*"GLOAS_FORK_EPOCH"[[:space:]]*:[[:space:]]*"([0-9]+)".*/\1/p' | head -n1)"
        vs="$(printf '%s' "$sj" | sed -nE 's/.*"SLOTS_PER_EPOCH"[[:space:]]*:[[:space:]]*"([0-9]+)".*/\1/p' | head -n1)"
        [[ -n "$vg" ]] && ge="$vg"
        [[ -n "$vs" ]] && spe="$vs"
    fi
fi
ge="${ge:-1000}"
gloas_slot=$((ge * spe))
export FORK_SLOTS_MASTER="${FORK_SLOTS_MASTER:-0,0,0,0,0,0,${gloas_slot}}"
export GLOAS_SLOT="${GLOAS_SLOT:-$gloas_slot}"

log "Preparing ${V141_REF} worktree at ${V141_WORKDIR}"
MASTER_REF="$V141_REF" MASTER_WORKDIR="$V141_WORKDIR" \
    "${SCRIPT_DIR}/prepare-master-worktree.sh"

log "Executing RocketUpgradeOneDotFourDotOne"
log "  PROVIDER_URL=${PROVIDER_URL}"
log "  FORK_SLOTS_MASTER=${FORK_SLOTS_MASTER}"

export PROVIDER_URL PRIVATE_KEY V141_WORKDIR
export MASTER_WORKDIR="$V141_WORKDIR"
node "${SCRIPT_DIR}/deploy-upgrade-v1.4.1.js"
