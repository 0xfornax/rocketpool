#!/usr/bin/env bash
# Compile this checkout and execute RocketUpgradeOneDotFive against an existing
# local v1.4.0 / v1.4.1 deployment. Run after Gloas is active (the v1.5 megapool
# delegate needs the increased contract-size limit).
#
# Prerequisites: guardian bootstrap still open; deployments/latest.json from the
# existing deploy; EL/CL APIs reachable; Node.js >= 22 and Foundry installed.
#
# Usage:
#   ./scripts/devnet-7/upgrade-to-v1.5.sh
#   PROVIDER_URL=http://127.0.0.1:32003 CL_HTTP=http://127.0.0.1:33101 \
#     ./scripts/devnet-7/upgrade-to-v1.5.sh
#
# Overrides: DEPLOYMENT_FILE, PRIVATE_KEY, V15_ARTIFACT_DIR, DEPLOY_GAS_LIMIT,
# EXECUTE_GAS_LIMIT and the constructor/settings overrides accepted by
# deploy-upgrade-v1.5.js. If CL_HTTP is unavailable, explicitly supply
# SLOTS_PER_HISTORICAL_ROOT and FORK_SLOTS (seven comma-separated slots,
# Altair..Gloas).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=kurtosis-ports.env
source "${SCRIPT_DIR}/kurtosis-ports.env"

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

export PROVIDER_URL="${PROVIDER_URL:-${EL_HTTP:-$KURTOSIS_EL_HTTP_DEFAULT}}"
export CL_HTTP="${CL_HTTP:-$KURTOSIS_CL_HTTP_DEFAULT}"
export PRIVATE_KEY="${PRIVATE_KEY:-0xbcdf20249abf0ed6d944c0288fad489e33f66b3960d9e6229c1cd214ed3bbe31}"
export DEPLOYMENT_FILE="${DEPLOYMENT_FILE:-${ROOT_DIR}/deployments/latest.json}"
export V15_ARTIFACT_DIR="${V15_ARTIFACT_DIR:-${ROOT_DIR}/artifacts-v15}"
export DEPLOY_GAS_LIMIT="${DEPLOY_GAS_LIMIT:-150000000}"

command -v node >/dev/null 2>&1 || die "node is required"
command -v forge >/dev/null 2>&1 || die "forge is required (Foundry)"
[[ -f "$DEPLOYMENT_FILE" ]] || die "missing ${DEPLOYMENT_FILE}"
[[ -d "${ROOT_DIR}/node_modules" ]] || die "node_modules missing; run npm install in ${ROOT_DIR}"

# Resolve relative deployment/artifact paths against the caller's directory.
export DEPLOYMENT_FILE="$(realpath "$DEPLOYMENT_FILE")"
export V15_ARTIFACT_DIR="$(realpath -m "$V15_ARTIFACT_DIR")"

log "Reading BeaconStateVerifier parameters from ${CL_HTTP}"
beacon_params="$(node <<'NODE'
async function beacon(endpoint) {
    const response = await fetch(process.env.CL_HTTP.replace(/\/$/, '') + endpoint, {
        signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Beacon API ${endpoint}: HTTP ${response.status}`);
    return (await response.json()).data;
}

async function main() {
    const env = process.env;
    const names = ['SLOTS_PER_HISTORICAL_ROOT', 'FORK_SLOTS'];
    let spec;
    if (names.some(name => !env[name])) {
        spec = await beacon('/eth/v1/config/spec');
    }
    const historical = env.SLOTS_PER_HISTORICAL_ROOT || spec.SLOTS_PER_HISTORICAL_ROOT;
    const maxSlot = (1n << 64n) - 1n;
    const forks = env.FORK_SLOTS ? env.FORK_SLOTS.split(',').map(s => s.trim())
        : ['ALTAIR', 'BELLATRIX', 'CAPELLA', 'DENEB', 'ELECTRA', 'FULU', 'GLOAS'].map(fork => {
            const epoch = BigInt(spec[`${fork}_FORK_EPOCH`]);
            return String(epoch === maxSlot ? maxSlot : epoch * BigInt(spec.SLOTS_PER_EPOCH));
        });
    if (!/^[0-9]+$/.test(historical) || BigInt(historical) === 0n) {
        throw new Error('SLOTS_PER_HISTORICAL_ROOT must be a positive integer');
    }
    if (forks.length !== 7 || forks.some(s => !/^[0-9]+$/.test(s) || BigInt(s) > maxSlot)) {
        throw new Error('FORK_SLOTS must contain seven uint64 slots (Altair..Gloas)');
    }
    for (let i = 1; i < forks.length; i++) {
        if (BigInt(forks[i]) < BigInt(forks[i - 1])) throw new Error('FORK_SLOTS must be in ascending order');
    }
    if (spec) {
        const head = await beacon('/eth/v1/beacon/headers/head');
        if (BigInt(head.header.message.slot) < BigInt(forks[6])) {
            throw new Error(`Gloas is not active yet; re-run once head reaches slot ${forks[6]}`);
        }
    }
    console.log([historical, forks.join(',')].join(' '));
}
main().catch(err => { console.error(err.message); process.exit(1); });
NODE
)"
read -r SLOTS_PER_HISTORICAL_ROOT FORK_SLOTS <<< "$beacon_params"
export SLOTS_PER_HISTORICAL_ROOT FORK_SLOTS

log "Compiling v1.5 upgrade targets from ${ROOT_DIR}"
log "  V15_ARTIFACT_DIR=${V15_ARTIFACT_DIR}"
(
    cd "$ROOT_DIR"
    forge build \
        --out "$V15_ARTIFACT_DIR" \
        --use 0.8.30 \
        --optimize \
        --optimizer-runs 15000 \
        --via-ir \
        --evm-version cancun \
        --remappings "@openzeppelin/contracts/=node_modules/@openzeppelin/contracts/" \
        --remappings "@openzeppelin4/contracts/=node_modules/@openzeppelin4/contracts/" \
        contracts/contract/upgrade/RocketUpgradeOneDotFive.sol \
        contracts/contract/megapool/RocketMegapoolDelegate.sol \
        contracts/contract/util/BeaconStateVerifier.sol \
        contracts/contract/network/RocketNetworkExit.sol \
        contracts/contract/network/RocketNetworkRedemptions.sol \
        contracts/contract/network/RocketNetworkParticipation.sol \
        contracts/contract/dao/protocol/settings/RocketDAOProtocolSettingsMegapool.sol \
        contracts/contract/dao/protocol/settings/RocketDAOProtocolSettingsNetwork.sol \
        contracts/contract/megapool/RocketMegapoolManager.sol \
        contracts/contract/network/RocketNetworkPenalties.sol

    log "Compiling v1.5 minipool delegate/base (Solidity 0.7.6)"
    forge build \
        --out "$V15_ARTIFACT_DIR" \
        --use 0.7.6 \
        --optimize \
        --optimizer-runs 15000 \
        --evm-version istanbul \
        --remappings "@openzeppelin/contracts/=node_modules/@openzeppelin/contracts/" \
        contracts/contract/minipool/RocketMinipoolDelegate.sol \
        contracts/contract/minipool/RocketMinipoolBase.sol

    log "Executing RocketUpgradeOneDotFive"
    log "  PROVIDER_URL=${PROVIDER_URL}"
    log "  FORK_SLOTS=${FORK_SLOTS}"
    node "${SCRIPT_DIR}/deploy-upgrade-v1.5.js"
)
