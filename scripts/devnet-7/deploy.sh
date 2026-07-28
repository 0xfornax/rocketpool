#!/usr/bin/env bash
# Deploy a lean glamsterdam-devnet-7 Kurtosis network and Rocket Pool stack.
#
# Flow:
#   1. Launch Kurtosis (Fulu genesis; Gloas at epoch 4, ~26 min)
#   2. Deploy Rocket Pool from MASTER_REF (same pre-Gloas baseline as production)
#   3. Helpers + oDAO bootstrap + seed (operator ETH/RPL + deposit pool)
#   4. Wait for Gloas
#   5. Upgrade to THIS branch (v1.5 / RocketUpgradeOneDotFive)
#
# Spec:    https://notes.ethereum.org/@ethpandaops/glamsterdam-devnet-7
# Package: https://github.com/ethpandaops/ethereum-package
#
# Usage:
#   ./scripts/devnet-7/deploy.sh
#   ENCLAVE=my-devnet CLEAN=1 ./scripts/devnet-7/deploy.sh
#   SKIP_KURTOSIS=1 PROVIDER_URL=http://127.0.0.1:8545 ./scripts/devnet-7/deploy.sh
#   SKIP_UPGRADE=1 ./scripts/devnet-7/deploy.sh   # leave at master contracts only
#
# Environment:
#   ENCLAVE              Kurtosis enclave name (default: rp-devnet-7)
#   CLEAN=1              Remove existing enclave before launching
#   SKIP_KURTOSIS=1      Skip network launch; only deploy contracts against PROVIDER_URL
#   SKIP_DEPLOY=1        Launch network only; skip Rocket Pool deploy
#   SKIP_ODAO=1          Skip oDAO bootstrap / Smart Node config generation
#   SKIP_SEED=1          Skip ETH/RPL funding of SEED_ADDRESS and deposit-pool seed
#   SKIP_REGISTER=1      Skip registering /srv/rocketpool3 Smart Node wallet as RP node
#   SKIP_UPGRADE=1       Skip v1.5 upgrade (stay on master contracts)
#   MASTER_REF           Git ref for baseline deploy (default: master)
#   MASTER_WORKDIR       Worktree path (default: <repo>/.devnet-master)
#   PRIVATE_KEY          Guardian/deployer key (default: ethereum-package prefunded #0)
#   ODAO_PRIVATE_KEY     oDAO member key (default: ethereum-package prefunded #1)
#   RP_DIR               Smart Node tree for wallet/register (default: /srv/rocketpool3)
#   SEED_ADDRESS         Operator to fund (default: 0xc7EBC35C761bFbaE449973E226CE3295B9B7f996)
#   SEED_ETH / SEED_RPL  Amounts sent to SEED_ADDRESS (defaults: 100 / 10000)
#   DEPOSIT_POOL_ETH     User deposit into RocketDepositPool (default: 500)
#   NODE_TIMEZONE        registerNode timezone (default: Australia/Brisbane)
#   ETHEREUM_PACKAGE     Kurtosis package ref (default: github.com/ethpandaops/ethereum-package)
#   WAIT_TIMEOUT_SECS    RPC readiness timeout (default: 300)
#   GLOAS_WAIT_TIMEOUT_SECS  Wait for Gloas before v1.5 upgrade (default: 2400)
#   DISCOVER_PORTS=1     Use `kurtosis port print` instead of fixed ports
#   EL_HTTP / CL_HTTP    Override EL/CL URLs (default: fixed port_publisher ports)
#
# Notes:
#   - network_params.yaml uses mainnet preset (SSZ dimensions for Smart Node proofs).
#   - Master (production) contracts — including megapool — are the pre-Gloas baseline;
#     they are deployed as soon as the EL is ready. The v1.5 upgrade waits for Gloas.
#   - Host ports are fixed via network_params.yaml port_publisher + kurtosis-ports.env
#     (EL RPC 32003, EL WS 32004, CL HTTP 33001). sync_smartnode_config still rewrites
#     odao-smartnode.env / user-settings.yml when contract addresses change.
#   - Kurtosis 1.20 can stop an enclave but cannot resume a fully STOPPED one.
#   - CLEAN=1 is required when switching preset/fork schedule.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NETWORK_PARAMS="${SCRIPT_DIR}/network_params.yaml"
# shellcheck source=kurtosis-ports.env
source "${SCRIPT_DIR}/kurtosis-ports.env"
DISCOVER_PORTS="${DISCOVER_PORTS:-0}"

ENCLAVE="${ENCLAVE:-rp-devnet-7}"
CLEAN="${CLEAN:-0}"
SKIP_KURTOSIS="${SKIP_KURTOSIS:-0}"
SKIP_DEPLOY="${SKIP_DEPLOY:-0}"
SKIP_ODAO="${SKIP_ODAO:-0}"
SKIP_SEED="${SKIP_SEED:-0}"
SKIP_REGISTER="${SKIP_REGISTER:-0}"
SKIP_UPGRADE="${SKIP_UPGRADE:-0}"
ETHEREUM_PACKAGE="${ETHEREUM_PACKAGE:-github.com/ethpandaops/ethereum-package}"
WAIT_TIMEOUT_SECS="${WAIT_TIMEOUT_SECS:-300}"
# Wait for delayed Gloas before the v1.5 upgrade (not before master deploy).
# Default covers gloas_fork_epoch: 4 on mainnet preset (~26 min) + margin.
GLOAS_WAIT_TIMEOUT_SECS="${GLOAS_WAIT_TIMEOUT_SECS:-2400}"
MASTER_REF="${MASTER_REF:-master}"
MASTER_WORKDIR="${MASTER_WORKDIR:-${ROOT_DIR}/.devnet-master}"
# Local Smart Node / megapool operator funded after each deploy
# Default SEED_ADDRESS matches /srv/rocketpool3 HD wallet index 0.
RP_DIR="${RP_DIR:-/srv/rocketpool3}"
SEED_ADDRESS="${SEED_ADDRESS:-0xc7EBC35C761bFbaE449973E226CE3295B9B7f996}"
SEED_ETH="${SEED_ETH:-100}"
SEED_RPL="${SEED_RPL:-10000}"
DEPOSIT_POOL_ETH="${DEPOSIT_POOL_ETH:-500}"
NODE_TIMEZONE="${NODE_TIMEZONE:-Australia/Brisbane}"

# ethereum-package prefunded accounts (genesis_constants.star)
# #0 guardian/deployer, #1 oDAO member
DEFAULT_PRIVATE_KEY="0xbcdf20249abf0ed6d944c0288fad489e33f66b3960d9e6229c1cd214ed3bbe31"
DEFAULT_DEPLOYER_ADDRESS="0x8943545177806ED17B9F23F0a21ee5948eCaa776"
DEFAULT_ODAO_PRIVATE_KEY="0x39725efee3fb28614de3bacaffe4cc4bd8c436257e2c8bb887c4b5c4be45e76d"
DEFAULT_ODAO_ADDRESS="0xE25583099BA105D9ec0A67f5Ae86D90e50036425"
# ethereum-package standard mnemonic (account #0/#1 match the keys above)
DEFAULT_MNEMONIC="giant issue aisle success illegal bike spike question tent bar rely arctic volcano long crawl hungry vocal artwork sniff fantasy very lucky have athlete"
PRIVATE_KEY="${PRIVATE_KEY:-$DEFAULT_PRIVATE_KEY}"
ODAO_PRIVATE_KEY="${ODAO_PRIVATE_KEY:-$DEFAULT_ODAO_PRIVATE_KEY}"
MNEMONIC="${MNEMONIC:-$DEFAULT_MNEMONIC}"
# Large contracts (RocketMegapoolDelegate ~44KiB) need ~67M gas under Glamsterdam
# state-creation costs; eth_estimateGas currently fails with "code storage out of gas".
# Requires geth --rpc.gascap high enough (see network_params.yaml). Cap is below
# block gas limit (200M) but above megapool creation cost.
DEPLOY_GAS_LIMIT="${DEPLOY_GAS_LIMIT:-150000000}"

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed"
}

check_prereqs() {
    require_cmd docker
    require_cmd node
    require_cmd npx
    if [[ "$SKIP_KURTOSIS" != "1" ]]; then
        if ! command -v kurtosis >/dev/null 2>&1; then
            die "kurtosis is not installed. Install: https://docs.kurtosis.com/install"
        fi
    fi
    if [[ ! -d "${ROOT_DIR}/node_modules" ]]; then
        die "node_modules missing; run 'npm install' in ${ROOT_DIR}"
    fi
    if [[ ! -f "$NETWORK_PARAMS" ]]; then
        die "missing network params: ${NETWORK_PARAMS}"
    fi
    docker info >/dev/null 2>&1 || die "Docker daemon is not running"
}

# Print enclave status from `kurtosis enclave ls` (RUNNING / STOPPED / empty if missing).
enclave_status() {
    # Columns: UUID Name Status ...
    kurtosis enclave ls 2>/dev/null | awk -v name="$ENCLAVE" 'NR>1 && $2==name {print $3; exit}'
}

enclave_exists() {
    local status
    status="$(enclave_status)"
    [[ -n "$status" ]]
}

enclave_is_running() {
    [[ "$(enclave_status)" == "RUNNING" ]]
}

remove_enclave() {
    log "Removing enclave '${ENCLAVE}'"
    kurtosis enclave rm -f "$ENCLAVE" 2>/dev/null || true
}

launch_kurtosis() {
    local status
    status="$(enclave_status)"

    # Kurtosis 1.20 has `enclave stop` but no `enclave start`. A fully STOPPED
    # enclave cannot be resumed (service start also fails). Always recreate it.
    if [[ "$CLEAN" == "1" && -n "$status" ]]; then
        remove_enclave
        status=""
    elif [[ "$status" == "STOPPED" ]]; then
        log "Enclave '${ENCLAVE}' is STOPPED (cannot resume on this Kurtosis CLI); recreating"
        remove_enclave
        status=""
    fi

    if [[ "$status" == "RUNNING" ]]; then
        log "Reusing existing RUNNING enclave '${ENCLAVE}'"
        return
    fi

    log "Launching Kurtosis enclave '${ENCLAVE}' (devnet-7 lean config)"
    log "Package: ${ETHEREUM_PACKAGE}"
    log "Params:  ${NETWORK_PARAMS}"
    kurtosis run \
        --enclave "$ENCLAVE" \
        "$ETHEREUM_PACKAGE" \
        --args-file "$NETWORK_PARAMS"
}

# Resolve host-facing EL JSON-RPC URL.
# Default: fixed port_publisher port (kurtosis-ports.env). DISCOVER_PORTS=1 uses
# `kurtosis port print` (exact name "rpc", not "engine-rpc").
resolve_el_rpc() {
    local url=""

    if [[ -n "${EL_HTTP:-}" ]]; then
        printf '%s\n' "$EL_HTTP"
        return 0
    fi

    if [[ "$DISCOVER_PORTS" != "1" ]]; then
        printf '%s\n' "$KURTOSIS_EL_HTTP_DEFAULT"
        return 0
    fi

    local port_line=""
    local service

    for service in el-1-geth-lighthouse el-1-geth $(kurtosis enclave inspect "$ENCLAVE" 2>/dev/null | sed -nE 's/^[[:space:]]*[a-f0-9]+[[:space:]]+(el-[^[:space:]]+).*/\1/p' | head -n1); do
        if port_line="$(kurtosis port print "$ENCLAVE" "$service" rpc 2>/dev/null)"; then
            break
        fi
    done

    if [[ -n "${port_line}" ]]; then
        port_line="$(printf '%s' "$port_line" | tr -d '[:space:]')"
        if [[ "$port_line" =~ ^https?:// ]]; then
            url="$port_line"
        elif [[ "$port_line" == *:* ]]; then
            url="http://${port_line}"
        else
            url="http://127.0.0.1:${port_line}"
        fi
    fi

    if [[ -z "$url" ]]; then
        local inspect
        inspect="$(kurtosis enclave inspect "$ENCLAVE" 2>/dev/null || true)"
        # Match the JSON-RPC port only (label "rpc"), not "engine-rpc".
        url="$(printf '%s\n' "$inspect" | grep -E '[[:space:]]rpc:' | sed -nE 's/.*rpc:[[:space:]]*[0-9]+\/tcp[[:space:]]*->[[:space:]]*(https?:\/\/)?([0-9.]+):([0-9]+).*/http:\/\/\2:\3/p' | head -n1)"
    fi

    # Fall back to fixed defaults if discovery failed
    url="${url:-$KURTOSIS_EL_HTTP_DEFAULT}"
    [[ -n "${url:-}" ]] || die "could not resolve EL RPC URL from enclave '${ENCLAVE}'"
    printf '%s\n' "$url"
}

# Parse first CL HTTP URL (for genesis beacon API fallback).
resolve_cl_http() {
    local url=""

    if [[ -n "${CL_HTTP:-}" ]]; then
        printf '%s\n' "$CL_HTTP"
        return 0
    fi

    if [[ "$DISCOVER_PORTS" != "1" ]]; then
        printf '%s\n' "$KURTOSIS_CL_HTTP_DEFAULT"
        return 0
    fi

    local port_line=""
    local service

    for service in cl-1-lighthouse-geth cl-1-lighthouse $(kurtosis enclave inspect "$ENCLAVE" 2>/dev/null | sed -nE 's/^[[:space:]]*[a-f0-9]+[[:space:]]+(cl-[^[:space:]]+).*/\1/p' | head -n1); do
        if port_line="$(kurtosis port print "$ENCLAVE" "$service" http 2>/dev/null)"; then
            break
        fi
    done

    if [[ -n "${port_line}" ]]; then
        port_line="$(printf '%s' "$port_line" | tr -d '[:space:]')"
        if [[ "$port_line" =~ ^https?:// ]]; then
            url="$port_line"
        elif [[ "$port_line" == *:* ]]; then
            url="http://${port_line}"
        else
            url="http://127.0.0.1:${port_line}"
        fi
    fi

    if [[ -z "$url" ]]; then
        local inspect
        inspect="$(kurtosis enclave inspect "$ENCLAVE" 2>/dev/null || true)"
        url="$(printf '%s\n' "$inspect" | grep -E '[[:space:]]http:' | sed -nE 's/.*http:[[:space:]]*[0-9]+\/tcp[[:space:]]*->[[:space:]]*(https?:\/\/)?([0-9.]+):([0-9]+).*/http:\/\/\2:\3/p' | head -n1)"
    fi
    printf '%s\n' "${url:-$KURTOSIS_CL_HTTP_DEFAULT}"
}

rpc_call() {
    local url="$1"
    local method="$2"
    local params="${3:-[]}"
    curl -sf -X POST "$url" \
        -H 'Content-Type: application/json' \
        --data "{\"jsonrpc\":\"2.0\",\"method\":\"${method}\",\"params\":${params},\"id\":1}"
}

wait_for_rpc() {
    local url="$1"
    local deadline=$((SECONDS + WAIT_TIMEOUT_SECS))
    log "Waiting for EL RPC at ${url} (timeout ${WAIT_TIMEOUT_SECS}s)"
    while (( SECONDS < deadline )); do
        if resp="$(rpc_call "$url" eth_blockNumber 2>/dev/null)"; then
            if printf '%s' "$resp" | grep -q '"result"'; then
                local hex
                hex="$(printf '%s' "$resp" | sed -nE 's/.*"result"[[:space:]]*:[[:space:]]*"(0x[0-9a-fA-F]+)".*/\1/p' | head -n1)"
                if [[ -n "$hex" ]]; then
                    local n=$((hex))
                    if (( n > 0 )); then
                        log "EL is producing blocks (blockNumber=${n})"
                        return 0
                    fi
                    log "EL reachable at genesis (block 0); waiting for first block..."
                fi
            fi
        fi
        sleep 2
    done
    die "timed out waiting for EL RPC at ${url}"
}

# Poll the CL until head reports eth-consensus-version: gloas (or state is past fork epoch).
# Used before the v1.5 upgrade only — master baseline deploys on pre-Gloas Fulu.
wait_for_gloas() {
    local cl_http
    cl_http="$(resolve_cl_http || true)"
    if [[ -z "${cl_http}" ]]; then
        log "warning: could not resolve CL HTTP; sleeping 800s as a Gloas wait fallback"
        sleep 800
        return 0
    fi

    local gloas_epoch=""
    local slots_per_epoch="32"
    local seconds_per_slot="12"
    local spec_json
    if spec_json="$(curl -sf --max-time 10 "${cl_http}/eth/v1/config/spec" 2>/dev/null)"; then
        local v
        v="$(printf '%s' "$spec_json" | sed -nE 's/.*"GLOAS_FORK_EPOCH"[[:space:]]*:[[:space:]]*"([0-9]+)".*/\1/p' | head -n1)"
        [[ -n "$v" ]] && gloas_epoch="$v"
        v="$(printf '%s' "$spec_json" | sed -nE 's/.*"SLOTS_PER_EPOCH"[[:space:]]*:[[:space:]]*"([0-9]+)".*/\1/p' | head -n1)"
        [[ -n "$v" ]] && slots_per_epoch="$v"
        v="$(printf '%s' "$spec_json" | sed -nE 's/.*"SECONDS_PER_SLOT"[[:space:]]*:[[:space:]]*"([0-9]+)".*/\1/p' | head -n1)"
        [[ -n "$v" ]] && seconds_per_slot="$v"
    fi
    if [[ -z "$gloas_epoch" ]]; then
        # Fallback: parse network_params.yaml
        gloas_epoch="$(sed -nE 's/^[[:space:]]*gloas_fork_epoch:[[:space:]]*([0-9]+).*/\1/p' "$NETWORK_PARAMS" | head -n1)"
        gloas_epoch="${gloas_epoch:-0}"
    fi

    if [[ "$gloas_epoch" == "0" ]]; then
        log "Gloas already active at genesis (GLOAS_FORK_EPOCH=0); skipping wait"
        return 0
    fi

    local fork_slot=$((gloas_epoch * slots_per_epoch))
    local approx_secs=$((fork_slot * seconds_per_slot))
    log "Waiting for Gloas (EIP-7954 / ePBS) before contract deploy"
    log "  CL: ${cl_http}"
    log "  GLOAS_FORK_EPOCH=${gloas_epoch}  first Gloas slot=${fork_slot}  (~${approx_secs}s / $((approx_secs / 60))m after genesis)"
    log "  timeout ${GLOAS_WAIT_TIMEOUT_SECS}s"

    local deadline=$((SECONDS + GLOAS_WAIT_TIMEOUT_SECS))
    local last_log=0
    while (( SECONDS < deadline )); do
        # Prefer consensus-version on a state download (cheap HEAD-ish via range)
        local version
        version="$(curl -sf --max-time 10 -D - -o /dev/null \
            -H 'Accept: application/octet-stream' \
            "${cl_http}/eth/v2/debug/beacon/states/head" 2>/dev/null \
            | tr -d '\r' | sed -nE 's/^[Ee]th-[Cc]onsensus-[Vv]ersion:[[:space:]]*(.+)$/\1/p' | head -n1 | tr -d '[:space:]')"
        if [[ "${version,,}" == "gloas" ]]; then
            log "Gloas active (eth-consensus-version=${version})"
            return 0
        fi

        local slot=""
        local head_json
        if head_json="$(curl -sf --max-time 10 "${cl_http}/eth/v1/beacon/headers/head" 2>/dev/null)"; then
            slot="$(printf '%s' "$head_json" | sed -nE 's/.*"slot"[[:space:]]*:[[:space:]]*"([0-9]+)".*/\1/p' | head -n1)"
        fi
        if [[ -n "$slot" ]] && (( slot >= fork_slot )); then
            # Slot past fork epoch; re-check version once more
            version="$(curl -sf --max-time 10 -D - -o /dev/null \
                -H 'Accept: application/octet-stream' \
                "${cl_http}/eth/v2/debug/beacon/states/head" 2>/dev/null \
                | tr -d '\r' | sed -nE 's/^[Ee]th-[Cc]onsensus-[Vv]ersion:[[:space:]]*(.+)$/\1/p' | head -n1 | tr -d '[:space:]')"
            log "Head slot ${slot} >= ${fork_slot}; consensus-version=${version:-unknown}"
            if [[ "${version,,}" == "gloas" ]] || [[ -z "$version" ]]; then
                # Empty version still allow proceed if slot is past fork (some CLs omit header on error)
                [[ "${version,,}" == "gloas" ]] && return 0
                [[ -z "$version" ]] && log "warning: no consensus-version header; treating post-fork slot as Gloas" && return 0
            fi
        fi

        if (( SECONDS - last_log >= 30 )); then
            log "  still waiting... head_slot=${slot:-?} version=${version:-?} (need gloas / slot>=${fork_slot})"
            last_log=$SECONDS
        fi
        sleep 5
    done
    die "timed out waiting for Gloas after ${GLOAS_WAIT_TIMEOUT_SECS}s (need 64 KiB code size for RP contracts)"
}

# Download genesis artifacts and extract params needed by BeaconStateVerifier.
extract_genesis_params() {
    local tmpdir
    tmpdir="$(mktemp -d)"
    # shellcheck disable=SC2064
    trap "rm -rf '${tmpdir}'" RETURN

    local genesis_time=""
    local genesis_validators_root=""
    local seconds_per_slot="12"
    # Default matches mainnet preset (network_params.yaml); overridden by genesis/spec.
    local slots_per_historical_root="8192"

    # Dedicated ethereum-package artifacts (most reliable).
    local gvr_dir gt_dir
    gvr_dir="$(mktemp -d)"
    gt_dir="$(mktemp -d)"
    if kurtosis files download "$ENCLAVE" genesis_validators_root "$gvr_dir" >/dev/null 2>&1; then
        genesis_validators_root="$(tr -d '[:space:]' < "$(find "$gvr_dir" -type f | head -n1)")"
    fi
    if kurtosis files download "$ENCLAVE" final-genesis-timestamp "$gt_dir" >/dev/null 2>&1; then
        genesis_time="$(tr -d '[:space:]' < "$(find "$gt_dir" -type f | head -n1)")"
    fi
    rm -rf "$gvr_dir" "$gt_dir"

    # ethereum-package names this artifact el_cl_genesis_data (underscores).
    log "Downloading el_cl_genesis_data from enclave '${ENCLAVE}'"
    if kurtosis files download "$ENCLAVE" el_cl_genesis_data "$tmpdir" >/dev/null 2>&1 \
        || kurtosis files download "$ENCLAVE" el-cl-genesis-data "$tmpdir" >/dev/null 2>&1; then
        local config_file
        config_file="$(find "$tmpdir" -type f \( -name 'config.yaml' -o -name 'config.yml' \) 2>/dev/null | head -n1 || true)"
        if [[ -n "${config_file}" ]]; then
            if grep -qE '^MINIMAL_PRESET:[[:space:]]*true|^PRESET_BASE:[[:space:]]*['\''"]?minimal' "$config_file" 2>/dev/null; then
                slots_per_historical_root="64"
            elif grep -qE '^PRESET_BASE:[[:space:]]*['\''"]?mainnet' "$config_file" 2>/dev/null; then
                slots_per_historical_root="8192"
            fi
            local v
            v="$(sed -nE 's/^SECONDS_PER_SLOT:[[:space:]]*([0-9]+).*/\1/p' "$config_file" | head -n1)"
            [[ -n "$v" ]] && seconds_per_slot="$v"
            v="$(sed -nE 's/^SLOTS_PER_HISTORICAL_ROOT:[[:space:]]*([0-9]+).*/\1/p' "$config_file" | head -n1)"
            [[ -n "$v" ]] && slots_per_historical_root="$v"
        fi
    else
        log "warning: could not download el_cl_genesis_data; trying Beacon API for remaining fields"
    fi

    # Beacon API fill-in
    local cl_http
    cl_http="$(resolve_cl_http || true)"
    if [[ -n "${cl_http}" ]]; then
        local genesis_json_api
        if genesis_json_api="$(curl -sf "${cl_http}/eth/v1/beacon/genesis" 2>/dev/null)"; then
            local v
            if [[ -z "$genesis_time" ]]; then
                v="$(printf '%s' "$genesis_json_api" | sed -nE 's/.*"genesis_time"[[:space:]]*:[[:space:]]*"([0-9]+)".*/\1/p' | head -n1)"
                [[ -n "$v" ]] && genesis_time="$v"
            fi
            if [[ -z "$genesis_validators_root" ]]; then
                v="$(printf '%s' "$genesis_json_api" | sed -nE 's/.*"genesis_validators_root"[[:space:]]*:[[:space:]]*"(0x[0-9a-fA-F]+)".*/\1/p' | head -n1)"
                [[ -n "$v" ]] && genesis_validators_root="$v"
            fi
        fi
        local spec_json
        if spec_json="$(curl -sf "${cl_http}/eth/v1/config/spec" 2>/dev/null)"; then
            local v
            v="$(printf '%s' "$spec_json" | sed -nE 's/.*"SECONDS_PER_SLOT"[[:space:]]*:[[:space:]]*"([0-9]+)".*/\1/p' | head -n1)"
            [[ -n "$v" ]] && seconds_per_slot="$v"
            v="$(printf '%s' "$spec_json" | sed -nE 's/.*"SLOTS_PER_HISTORICAL_ROOT"[[:space:]]*:[[:space:]]*"([0-9]+)".*/\1/p' | head -n1)"
            [[ -n "$v" ]] && slots_per_historical_root="$v"
        fi
    fi

    if [[ -z "${genesis_time}" ]]; then
        die "could not determine GENESIS_BLOCK_TIMESTAMP; set it manually and re-run with SKIP_KURTOSIS=1"
    fi
    if [[ -z "${genesis_validators_root}" ]]; then
        log "warning: GENESIS_VALIDATOR_ROOT unknown; using zero hash (beacon proofs will be invalid)"
        genesis_validators_root="0x0000000000000000000000000000000000000000000000000000000000000000"
    fi

    export GENESIS_BLOCK_TIMESTAMP="$genesis_time"
    export GENESIS_VALIDATOR_ROOT="$genesis_validators_root"
    export SECONDS_PER_SLOT="$seconds_per_slot"
    export SLOTS_PER_HISTORICAL_ROOT="$slots_per_historical_root"
    # Master BSV: Altair..Electra (5). This-branch upgrade BSV: Altair..Fulu (6).
    export FORK_SLOTS_MASTER="${FORK_SLOTS_MASTER:-0,0,0,0,0}"
    export FORK_SLOTS="${FORK_SLOTS:-0,0,0,0,0,0}"

    log "Genesis time:              ${GENESIS_BLOCK_TIMESTAMP}"
    log "Genesis validators root:   ${GENESIS_VALIDATOR_ROOT}"
    log "Seconds per slot:          ${SECONDS_PER_SLOT}"
    log "Slots per historical root: ${SLOTS_PER_HISTORICAL_ROOT}"
    log "Fork slots master (A..E):  ${FORK_SLOTS_MASTER}"
    log "Fork slots v1.5 (A..Fulu): ${FORK_SLOTS}"
}

prepare_master_worktree() {
    log "Preparing master worktree (${MASTER_REF} → ${MASTER_WORKDIR})"
    MASTER_REF="$MASTER_REF" MASTER_WORKDIR="$MASTER_WORKDIR" \
        "${SCRIPT_DIR}/prepare-master-worktree.sh" >/dev/null
    [[ -d "$MASTER_WORKDIR" ]] || die "master worktree missing at ${MASTER_WORKDIR}"
}

# Patch smartnode Kurtosis Devnet hardcoded addresses from latest.json.
update_smartnode_addresses() {
    local sn_config="${SMARTNODE_CONFIG:-${ROOT_DIR}/../smartnode/shared/services/config/smartnode-config.go}"
    if [[ ! -f "$sn_config" ]]; then
        # Common layout: ~/rp/smartnode next to ~/rp/rocketpool
        sn_config="$(cd "${ROOT_DIR}/.." && pwd)/smartnode/shared/services/config/smartnode-config.go"
    fi
    if [[ ! -f "$sn_config" ]]; then
        log "warning: smartnode-config.go not found; skip Smart Node address update"
        log "  set SMARTNODE_CONFIG=/path/to/smartnode-config.go to enable"
        return 0
    fi
    log "Updating Smart Node Kurtosis Devnet defaults from latest.json"
    DEPLOYMENT_FILE="${ROOT_DIR}/deployments/latest.json" \
    SMARTNODE_CONFIG="$sn_config" \
    CHAIN_ID="${CHAIN_ID:-3151908}" \
        node "${SCRIPT_DIR}/update-smartnode-config.js"
}

# Rewrite odao-smartnode.env + /srv/rocketpool3 with fixed (or discovered) EL/CL URLs.
refresh_smartnode_ports() {
    if [[ ! -f "${ROOT_DIR}/deployments/latest.json" ]]; then
        log "warning: no deployments/latest.json yet; skip Smart Node port refresh"
        return 0
    fi
    log "Refreshing Smart Node EL/CL endpoints (fixed ports unless DISCOVER_PORTS=1)"
    if ENCLAVE="$ENCLAVE" DISCOVER_PORTS="$DISCOVER_PORTS" \
        EL_HTTP="${EL_HTTP:-}" EL_WS="${EL_WS:-}" CL_HTTP="${CL_HTTP:-}" \
        "${SCRIPT_DIR}/generate-odao-config.sh"; then
        local el cl
        el="$(sed -nE 's/^EL_HTTP=//p' "${ROOT_DIR}/deployments/odao-smartnode.env" | head -n1 || true)"
        cl="$(sed -nE 's/^CL_HTTP=//p' "${ROOT_DIR}/deployments/odao-smartnode.env" | head -n1 || true)"
        log "  Smart Node EL_HTTP=${el:-?}"
        log "  Smart Node CL_HTTP=${cl:-?}"
        log "  settings: /srv/rocketpool3/user-settings.yml (if present)"
    else
        log "warning: generate-odao-config.sh failed (ports/settings may be stale)"
        return 1
    fi
}

# Addresses + ports together — always call this instead of either step alone.
sync_smartnode_config() {
    log "Syncing Smart Node config (contract addresses + fixed EL/CL ports)"
    update_smartnode_addresses
    refresh_smartnode_ports || true
}

# Back-compat alias used by older call sites / docs.
update_smartnode_config() {
    sync_smartnode_config
}

# Baseline: deploy contracts from master branch into the Kurtosis chain.
deploy_rocket_pool_master() {
    local provider_url="$1"
    prepare_master_worktree
    log "Deploying Rocket Pool contracts from MASTER (${MASTER_REF})"
    log "  worktree: ${MASTER_WORKDIR}"
    log "  PROVIDER_URL=${provider_url}"
    log "  Deployer (prefunded #0): ${DEFAULT_DEPLOYER_ADDRESS}"
    log "  CHAIN=kurtosis (size-optimized artifacts, EIP-170 24 KiB)"

    (
        cd "$MASTER_WORKDIR"
        export PROVIDER_URL="$provider_url"
        export PRIVATE_KEY
        # Master hardhat.config.js uses MNEMONIC for --network custom (not PRIVATE_KEY).
        export MNEMONIC
        export CHAIN=kurtosis
        export GENESIS_BLOCK_TIMESTAMP
        export GENESIS_VALIDATOR_ROOT
        export SECONDS_PER_SLOT
        export SLOTS_PER_HISTORICAL_ROOT
        export FORK_SLOTS="$FORK_SLOTS_MASTER"
        export FORK_SLOTS_MASTER
        export DEPLOY_GAS_LIMIT
        # Write deployment artifacts into the parent repo (shared path)
        mkdir -p "${ROOT_DIR}/deployments"
        # master deploy.js writes to cwd/deployments — symlink into parent
        if [[ ! -e deployments ]]; then
            ln -sfn "${ROOT_DIR}/deployments" deployments
        elif [[ ! -L deployments ]]; then
            # Prefer parent deployments dir
            rm -rf deployments
            ln -sfn "${ROOT_DIR}/deployments" deployments
        fi
        npx hardhat run scripts/deploy.js --network custom
    )
    # Copy latest.json is already in shared deployments via symlink
    [[ -f "${ROOT_DIR}/deployments/latest.json" ]] \
        || die "master deploy did not produce deployments/latest.json"
    log "Master deploy complete; RocketStorage recorded in deployments/latest.json"

    # Addresses + live Kurtosis ports in one step.
    sync_smartnode_config
}

# After Gloas + master baseline: upgrade selected contracts to this branch (v1.5).
upgrade_rocket_pool_v1_5() {
    local provider_url="$1"
    log "Upgrading Rocket Pool contracts to THIS branch (v1.5 / RocketUpgradeOneDotFive)"
    log "  PROVIDER_URL=${provider_url}"
    (
        cd "$ROOT_DIR"
        export PROVIDER_URL="$provider_url"
        export PRIVATE_KEY
        export CHAIN=kurtosis
        export GENESIS_BLOCK_TIMESTAMP
        export GENESIS_VALIDATOR_ROOT
        export SECONDS_PER_SLOT
        export SLOTS_PER_HISTORICAL_ROOT
        export FORK_SLOTS
        export DEPLOY_GAS_LIMIT
        export ROCKET_STORAGE
        ROCKET_STORAGE="$(node -e "const d=require('${ROOT_DIR}/deployments/latest.json'); process.stdout.write(d.addresses.RocketStorage||'')")"
        export ROCKET_STORAGE
        [[ -n "$ROCKET_STORAGE" ]] || die "RocketStorage missing from latest.json"
        log "  RocketStorage=${ROCKET_STORAGE}"
        # Ensure this branch is compiled
        npx hardhat compile
        npx hardhat run scripts/devnet-7/deploy-upgrade-v1.5.js --network custom
    )
}

# Post-deploy check: protocol + node deposit flags must be enabled.
verify_deposits_enabled() {
    local provider_url="$1"
    local latest="${ROOT_DIR}/deployments/latest.json"
    [[ -f "$latest" ]] || die "missing ${latest}; cannot verify deposits"

    log "Verifying deposits are enabled on-chain"
    (
        cd "$ROOT_DIR"
        PROVIDER_URL="$provider_url" node "${SCRIPT_DIR}/verify-deposits.js" --rpc "$provider_url"
    )
}

deploy_helpers() {
    local provider_url="$1"
    log "Deploying Smart Node helpers (Multicall2, EthBalanceChecker)"
    (
        cd "$ROOT_DIR"
        export PROVIDER_URL="$provider_url"
        export PRIVATE_KEY
        export DEPLOY_GAS_LIMIT
        node "${SCRIPT_DIR}/deploy-helpers.js"
    )
}

bootstrap_odao() {
    local provider_url="$1"
    log "Bootstrapping single oDAO member (prefunded #1 / ODAO_PRIVATE_KEY)"
    (
        cd "$ROOT_DIR"
        export PROVIDER_URL="$provider_url"
        export PRIVATE_KEY
        export ODAO_PRIVATE_KEY
        export DEPLOY_GAS_LIMIT
        # Pure node script (does not need hardhat network accounts for member)
        node "${SCRIPT_DIR}/bootstrap-odao.js"
    )
}

verify_odao() {
    local provider_url="$1"
    log "Verifying oDAO membership on-chain"
    (
        cd "$ROOT_DIR"
        PROVIDER_URL="$provider_url" node "${SCRIPT_DIR}/verify-odao.js" --rpc "$provider_url"
    )
}

generate_odao_config() {
    log "Generating Smart Node connection draft (external EC/CC)"
    ENCLAVE="$ENCLAVE" "${SCRIPT_DIR}/generate-odao-config.sh"
}

seed_devnet() {
    local provider_url="$1"
    log "Seeding operator funds + deposit pool"
    log "  SEED_ADDRESS=${SEED_ADDRESS}  ETH=${SEED_ETH}  RPL=${SEED_RPL}  pool=${DEPOSIT_POOL_ETH}"
    (
        cd "$ROOT_DIR"
        export PROVIDER_URL="$provider_url"
        export PRIVATE_KEY
        export ODAO_PRIVATE_KEY
        export SEED_ADDRESS
        export SEED_ETH
        export SEED_RPL
        export DEPOSIT_POOL_ETH
        node "${SCRIPT_DIR}/seed-devnet.js"
    )
}

# Register /srv/rocketpool3 Smart Node wallet via RocketNodeManager.registerNode.
register_smartnode() {
    local provider_url="$1"
    log "Registering Smart Node wallet as Rocket Pool node"
    log "  RP_DIR=${RP_DIR}  timezone=${NODE_TIMEZONE}"
    if [[ ! -f "${RP_DIR}/data/wallet" ]]; then
        log "warning: ${RP_DIR}/data/wallet missing; skip node register"
        log "  init wallet first: rocketpool -c ${RP_DIR} wallet init"
        return 0
    fi
    (
        cd "$ROOT_DIR"
        export PROVIDER_URL="$provider_url"
        export RP_DIR
        export TIMEZONE="$NODE_TIMEZONE"
        node "${SCRIPT_DIR}/register-node.js"
    )
}

print_summary() {
    local provider_url="$1"
    log "--------------------------------------------------"
    log "Devnet-7 + Rocket Pool deploy complete"
    log "  Enclave:      ${ENCLAVE}"
    log "  EL RPC:       ${provider_url}"
    log "  Deployer:     ${DEFAULT_DEPLOYER_ADDRESS}"
    if [[ -f "${ROOT_DIR}/deployments/latest.json" ]]; then
        log "  Deployment:   ${ROOT_DIR}/deployments/latest.json"
        local storage
        storage="$(sed -nE 's/.*"RocketStorage"[[:space:]]*:[[:space:]]*"(0x[0-9a-fA-F]+)".*/\1/p' "${ROOT_DIR}/deployments/latest.json" | head -n1 || true)"
        [[ -n "${storage:-}" ]] && log "  RocketStorage: ${storage}"
    fi
    if [[ -f "${ROOT_DIR}/deployments/odao-local.json" ]]; then
        local odao_addr
        odao_addr="$(node -e "const d=require('${ROOT_DIR}/deployments/odao-local.json'); process.stdout.write(d.member.address)" 2>/dev/null || true)"
        log "  oDAO member:  ${odao_addr:-see deployments/odao-local.json}"
        log "  oDAO meta:    ${ROOT_DIR}/deployments/odao-local.json"
        [[ -f "${ROOT_DIR}/deployments/odao-smartnode.env" ]] && log "  Smart Node:   ${ROOT_DIR}/deployments/odao-smartnode.env"
        log "  Smart Node:   network=devnet; ports refreshed into /srv/rocketpool3/user-settings.yml"
    fi
    if [[ -f "${ROOT_DIR}/deployments/odao-smartnode.env" ]]; then
        local el_http cl_http
        el_http="$(sed -nE 's/^EL_HTTP=//p' "${ROOT_DIR}/deployments/odao-smartnode.env" | head -n1 || true)"
        cl_http="$(sed -nE 's/^CL_HTTP=//p' "${ROOT_DIR}/deployments/odao-smartnode.env" | head -n1 || true)"
        [[ -n "${el_http:-}" ]] && log "  Smart Node EL: ${el_http}"
        [[ -n "${cl_http:-}" ]] && log "  Smart Node CL: ${cl_http}"
    fi
    if [[ "$SKIP_SEED" != "1" ]]; then
        log "  Seed address: ${SEED_ADDRESS} (${SEED_ETH} ETH + ${SEED_RPL} RPL)"
        log "  Deposit pool: ${DEPOSIT_POOL_ETH} ETH user deposit"
    fi
    if [[ "$SKIP_REGISTER" != "1" ]]; then
        log "  Node register: Smart Node wallet under ${RP_DIR} (timezone ${NODE_TIMEZONE})"
    fi
    if [[ "$SKIP_UPGRADE" != "1" ]]; then
        log "  Upgrade:      v1.5 (RocketUpgradeOneDotFive) applied from this branch"
    else
        log "  Upgrade:      skipped (master contracts only)"
    fi
    log "  Master ref:   ${MASTER_REF} @ ${MASTER_WORKDIR}"
    log "Tear down with: kurtosis enclave rm -f ${ENCLAVE}"
    log "--------------------------------------------------"
}

main() {
    check_prereqs

    local provider_url="${PROVIDER_URL:-}"

    if [[ "$SKIP_KURTOSIS" != "1" ]]; then
        launch_kurtosis
        provider_url="$(resolve_el_rpc)"
        wait_for_rpc "$provider_url"
        extract_genesis_params
    else
        [[ -n "$provider_url" ]] || die "SKIP_KURTOSIS=1 requires PROVIDER_URL"
        log "Skipping Kurtosis launch; using PROVIDER_URL=${provider_url}"
        wait_for_rpc "$provider_url"
        # Allow caller-supplied genesis env vars; fill defaults if missing
        export GENESIS_BLOCK_TIMESTAMP="${GENESIS_BLOCK_TIMESTAMP:-0}"
        export GENESIS_VALIDATOR_ROOT="${GENESIS_VALIDATOR_ROOT:-0x0000000000000000000000000000000000000000000000000000000000000000}"
        export SECONDS_PER_SLOT="${SECONDS_PER_SLOT:-12}"
        export SLOTS_PER_HISTORICAL_ROOT="${SLOTS_PER_HISTORICAL_ROOT:-8192}"
        export FORK_SLOTS="${FORK_SLOTS:-0,0,0,0,0,0}"
        if [[ "$GENESIS_BLOCK_TIMESTAMP" == "0" ]]; then
            log "warning: GENESIS_BLOCK_TIMESTAMP is 0; set it for correct BeaconStateVerifier immutables"
        fi
    fi

    if [[ "$SKIP_DEPLOY" == "1" ]]; then
        log "SKIP_DEPLOY=1; network is ready at ${provider_url}"
        # Still sync addresses (if latest.json exists) + ports after enclave recreate.
        if [[ -f "${ROOT_DIR}/deployments/latest.json" ]]; then
            sync_smartnode_config
        else
            refresh_smartnode_ports || true
        fi
        print_summary "$provider_url"
        return 0
    fi

    # --- Phase A: master baseline (production pre-Gloas stack, incl. megapool) ---
    # Do NOT wait for Gloas here — master contracts match what ships before the
    # Gloas/v1.5 upgrade on production.
    # (deploy_rocket_pool_master already calls sync_smartnode_config)
    deploy_rocket_pool_master "$provider_url"
    verify_deposits_enabled "$provider_url"
    # Helpers are not part of master third-party deploy; always run from this branch.
    deploy_helpers "$provider_url"
    # Helpers updated Multicall / balance batcher / signer registry — addresses + ports.
    sync_smartnode_config

    if [[ "$SKIP_ODAO" != "1" ]]; then
        bootstrap_odao "$provider_url"
        verify_odao "$provider_url"
        # oDAO meta written — refresh env (ports + member key) together with addresses.
        sync_smartnode_config
    else
        log "SKIP_ODAO=1; leaving oDAO bootstrap for later"
    fi

    # Fund operator + seed deposit pool against master contracts.
    if [[ "$SKIP_SEED" != "1" ]]; then
        seed_devnet "$provider_url"
    else
        log "SKIP_SEED=1; skipping operator funding and deposit-pool seed"
    fi

    # Register the Smart Node wallet (/srv/rocketpool3) as an RP node.
    # Requires seed (ETH for gas) and contracts; uses wallet keystore + password.
    if [[ "$SKIP_REGISTER" != "1" ]]; then
        register_smartnode "$provider_url"
    else
        log "SKIP_REGISTER=1; skipping Smart Node wallet registerNode"
    fi

    # --- Phase B: after Gloas, upgrade to this branch (v1.5) ---
    if [[ "$SKIP_UPGRADE" != "1" ]]; then
        wait_for_gloas
        upgrade_rocket_pool_v1_5 "$provider_url"
        # BSV / megapool delegate etc. addresses changed — addresses + ports together.
        sync_smartnode_config
    else
        log "SKIP_UPGRADE=1; leaving network on master contracts (no Gloas wait)"
        # Final ports/address pass even when upgrade is skipped.
        sync_smartnode_config
    fi

    print_summary "$provider_url"
}

main "$@"
