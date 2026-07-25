#!/usr/bin/env bash
# Copy /srv/rocketpool2 → /srv/rocketpool3 (if needed) and patch for Kurtosis native mode.
#
# Usage:
#   ./scripts/devnet-7/setup-native-smartnode.sh
#   SRC=/srv/rocketpool2 DEST=/srv/rocketpool3 ./scripts/devnet-7/setup-native-smartnode.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${SRC:-/srv/rocketpool2}"
DEST="${DEST:-/srv/rocketpool3}"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/deployments/odao-smartnode.env}"
ENCLAVE="${ENCLAVE:-rp-devnet-7}"

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ -d "$SRC" ]] || die "source missing: ${SRC}"
[[ -f "$ENV_FILE" ]] || {
    log "env file missing; generating from live enclave"
    ENCLAVE="$ENCLAVE" "${SCRIPT_DIR}/generate-odao-config.sh"
}

if [[ ! -d "$DEST" ]]; then
    log "Copying ${SRC} → ${DEST}"
    if mkdir -p "$DEST" 2>/dev/null && [[ -w "$(dirname "$DEST")" || -w "$DEST" ]]; then
        cp -a "$SRC/." "$DEST/"
    else
        # /srv is often root-owned; use Docker to copy as root then chown to current user
        docker run --rm -v /srv:/srv alpine:latest sh -c \
            "cp -a '${SRC}' '${DEST}' && chown -R $(id -u):$(id -g) '${DEST}'"
    fi
else
    log "Destination ${DEST} already exists; not overwriting tree (will patch settings only)"
fi

# Ensure nested rocketpool/ mirror exists for scripts path layout
if [[ -d "${DEST}/rocketpool" ]]; then
    # Keep nested user-settings in sync with root
    if [[ -f "${DEST}/user-settings.yml" ]]; then
        cp -f "${DEST}/user-settings.yml" "${DEST}/rocketpool/user-settings.yml" 2>/dev/null || true
    fi
fi

# Fix restart/stop script paths if they hardcode /srv/rocketpool
for f in "${DEST}/rocketpool/restart-vc.sh" "${DEST}/rocketpool/stop-validator.sh" \
         "${DEST}/restart-vc.sh" "${DEST}/stop-validator.sh"; do
    if [[ -f "$f" ]]; then
        sed -i "s|/srv/rocketpool2|${DEST}|g; s|/srv/rocketpool/|${DEST}/|g; s|/srv/rocketpool\$|${DEST}|g" "$f" || true
    fi
done

log "Patching user-settings for Kurtosis native mode"
node "${SCRIPT_DIR}/patch-native-settings.js" \
    --settings "${DEST}/user-settings.yml" \
    --env "${ENV_FILE}" \
    --rp-dir "${DEST}"

if [[ -f "${DEST}/rocketpool/user-settings.yml" ]]; then
    node "${SCRIPT_DIR}/patch-native-settings.js" \
        --settings "${DEST}/rocketpool/user-settings.yml" \
        --env "${ENV_FILE}" \
        --rp-dir "${DEST}"
fi

# Point data paths at DEST/data (not the old /srv/rocketpool/data from the template)
mkdir -p "${DEST}/data/watchtower" "${DEST}/data/rewards-trees" "${DEST}/data/validators"

# Drop copied wallet so operator can recover oDAO key (do not reuse foreign wallet)
if [[ -f "${DEST}/data/wallet" ]]; then
    log "Moving template wallet aside (recover oDAO key into ${DEST})"
    mv -f "${DEST}/data/wallet" "${DEST}/data/wallet.template.bak" 2>/dev/null || true
    mv -f "${DEST}/data/password" "${DEST}/data/password.template.bak" 2>/dev/null || true
    mv -f "${DEST}/data/address" "${DEST}/data/address.template.bak" 2>/dev/null || true
fi

# Symlink or copy env for convenience
cp -f "${ENV_FILE}" "${DEST}/odao-smartnode.env"
ln -sfn "${ENV_FILE}" "${DEST}/ROCKETPOOL_KURTOSIS_ENV" 2>/dev/null || true

log "--------------------------------------------------"
log "Native Smart Node tree ready: ${DEST}"
log "  settings: ${DEST}/user-settings.yml"
log "  env:      ${DEST}/odao-smartnode.env"
log ""
log "Start (example, native mode with Kurtosis env):"
log "  set -a && source ${DEST}/odao-smartnode.env && set +a"
log "  export ROCKETPOOL_KURTOSIS_ENV=${DEST}/odao-smartnode.env"
log "  # recover oDAO wallet (member key is in the env file):"
log "  rocketpool -d ${DEST} -s ${DEST}/user-settings.yml wallet init   # or recover"
log "  rocketpool -d ${DEST} -s ${DEST}/user-settings.yml service start  # if applicable"
log "  # or run daemon natively against this settings file"
log "--------------------------------------------------"
