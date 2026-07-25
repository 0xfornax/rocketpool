#!/usr/bin/env bash
# Deploy a lean glamsterdam-devnet-7 Kurtosis network, Rocket Pool contracts,
# and bootstrap a single oDAO member (host-side Smart Node config draft).
#
# Spec:    https://notes.ethereum.org/@ethpandaops/glamsterdam-devnet-7
# Package: https://github.com/ethpandaops/ethereum-package
# Contracts: scripts/deploy.js (CHAIN=kurtosis)
# oDAO:      scripts/devnet-7/bootstrap-odao.js
#
# Usage:
#   ./scripts/devnet-7/deploy.sh
#   ENCLAVE=my-devnet CLEAN=1 ./scripts/devnet-7/deploy.sh
#   SKIP_KURTOSIS=1 PROVIDER_URL=http://127.0.0.1:8545 ./scripts/devnet-7/deploy.sh
#   SKIP_ODAO=1 ./scripts/devnet-7/deploy.sh
#
# Environment:
#   ENCLAVE              Kurtosis enclave name (default: rp-devnet-7)
#   CLEAN=1              Remove existing enclave before launching
#   SKIP_KURTOSIS=1      Skip network launch; only deploy contracts against PROVIDER_URL
#   SKIP_DEPLOY=1        Launch network only; skip Rocket Pool deploy
#   SKIP_ODAO=1          Skip oDAO bootstrap / Smart Node config generation
#   SKIP_SEED=1          Skip ETH/RPL funding of SEED_ADDRESS and deposit-pool seed
#   PRIVATE_KEY          Guardian/deployer key (default: ethereum-package prefunded #0)
#   ODAO_PRIVATE_KEY     oDAO member key (default: ethereum-package prefunded #1)
#   SEED_ADDRESS         Operator to fund (default: 0xc7EBC35C761bFbaE449973E226CE3295B9B7f996)
#   SEED_ETH / SEED_RPL  Amounts sent to SEED_ADDRESS (defaults: 100 / 10000)
#   DEPOSIT_POOL_ETH     User deposit into RocketDepositPool (default: 500)
#   ETHEREUM_PACKAGE     Kurtosis package ref (default: github.com/ethpandaops/ethereum-package)
#   WAIT_TIMEOUT_SECS    RPC readiness timeout (default: 300)
#
# Notes:
#   - network_params.yaml uses mainnet preset (SSZ dimensions for Smart Node proofs).
#   - Host-published ports change whenever the enclave is recreated; odao-smartnode.env
#     is regenerated at the end of a successful run — re-source it for Smart Node.
#   - Kurtosis 1.20 can stop an enclave but cannot resume a fully STOPPED one.
#     deploy.sh auto-recreates STOPPED enclaves (chain state is lost).
#   - CLEAN=1 is required when switching preset (minimal → mainnet); partial reuse
#     leaves an incompatible genesis and invalid BeaconStateVerifier immutables.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NETWORK_PARAMS="${SCRIPT_DIR}/network_params.yaml"

ENCLAVE="${ENCLAVE:-rp-devnet-7}"
CLEAN="${CLEAN:-0}"
SKIP_KURTOSIS="${SKIP_KURTOSIS:-0}"
SKIP_DEPLOY="${SKIP_DEPLOY:-0}"
SKIP_ODAO="${SKIP_ODAO:-0}"
SKIP_SEED="${SKIP_SEED:-0}"
ETHEREUM_PACKAGE="${ETHEREUM_PACKAGE:-github.com/ethpandaops/ethereum-package}"
WAIT_TIMEOUT_SECS="${WAIT_TIMEOUT_SECS:-300}"
# Local Smart Node / megapool operator funded after each deploy
SEED_ADDRESS="${SEED_ADDRESS:-0xc7EBC35C761bFbaE449973E226CE3295B9B7f996}"
SEED_ETH="${SEED_ETH:-100}"
SEED_RPL="${SEED_RPL:-10000}"
DEPOSIT_POOL_ETH="${DEPOSIT_POOL_ETH:-500}"

# ethereum-package prefunded accounts (genesis_constants.star)
# #0 guardian/deployer, #1 oDAO member
DEFAULT_PRIVATE_KEY="0xbcdf20249abf0ed6d944c0288fad489e33f66b3960d9e6229c1cd214ed3bbe31"
DEFAULT_DEPLOYER_ADDRESS="0x8943545177806ED17B9F23F0a21ee5948eCaa776"
DEFAULT_ODAO_PRIVATE_KEY="0x39725efee3fb28614de3bacaffe4cc4bd8c436257e2c8bb887c4b5c4be45e76d"
DEFAULT_ODAO_ADDRESS="0xE25583099BA105D9ec0A67f5Ae86D90e50036425"
PRIVATE_KEY="${PRIVATE_KEY:-$DEFAULT_PRIVATE_KEY}"
ODAO_PRIVATE_KEY="${ODAO_PRIVATE_KEY:-$DEFAULT_ODAO_PRIVATE_KEY}"
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
# Prefer `kurtosis port print` (exact port name "rpc", not "engine-rpc").
resolve_el_rpc() {
    local url=""
    local port_line=""
    local service

    # Discover the first geth (or any el-*) service name from inspect if needed.
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

    [[ -n "${url:-}" ]] || die "could not resolve EL RPC URL from enclave '${ENCLAVE}'"
    printf '%s\n' "$url"
}

# Parse first CL HTTP URL (for genesis beacon API fallback).
resolve_cl_http() {
    local url=""
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
    printf '%s\n' "${url:-}"
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
    # All pre-Gloas forks at genesis (gloas_fork_epoch: 0 in network_params.yaml)
    export FORK_SLOTS="${FORK_SLOTS:-0,0,0,0,0,0}"

    log "Genesis time:              ${GENESIS_BLOCK_TIMESTAMP}"
    log "Genesis validators root:   ${GENESIS_VALIDATOR_ROOT}"
    log "Seconds per slot:          ${SECONDS_PER_SLOT}"
    log "Slots per historical root: ${SLOTS_PER_HISTORICAL_ROOT}"
    log "Fork slots (A..Fulu):      ${FORK_SLOTS}"
}

deploy_rocket_pool() {
    local provider_url="$1"
    log "Deploying Rocket Pool contracts via scripts/deploy.js"
    log "PROVIDER_URL=${provider_url}"
    log "Deployer (prefunded #0): ${DEFAULT_DEPLOYER_ADDRESS}"
    log "CHAIN=kurtosis"

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
        npx hardhat run scripts/deploy.js --network custom
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
        [[ -f "${ROOT_DIR}/deployments/odao-smartnode.env" ]] && log "  Smart Node:   ${ROOT_DIR}/deployments/odao-smartnode.env (draft)"
        log "  Smart Node:   network=devnet (Kurtosis); source odao-smartnode.env then start with external EC/CC"
    fi
    if [[ "$SKIP_SEED" != "1" ]]; then
        log "  Seed address: ${SEED_ADDRESS} (${SEED_ETH} ETH + ${SEED_RPL} RPL)"
        log "  Deposit pool: ${DEPOSIT_POOL_ETH} ETH user deposit"
    fi
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
        print_summary "$provider_url"
        return 0
    fi

    deploy_rocket_pool "$provider_url"
    verify_deposits_enabled "$provider_url"
    # Helpers may already be included via deployThirdParty on CHAIN=kurtosis; this
    # step is idempotent and fills addresses if the main deploy skipped them.
    deploy_helpers "$provider_url"

    if [[ "$SKIP_ODAO" != "1" ]]; then
        bootstrap_odao "$provider_url"
        verify_odao "$provider_url"
    else
        log "SKIP_ODAO=1; leaving oDAO bootstrap for later"
    fi

    # Fund operator + seed deposit pool (independent of oDAO; needs live RP contracts).
    if [[ "$SKIP_SEED" != "1" ]]; then
        seed_devnet "$provider_url"
    else
        log "SKIP_SEED=1; skipping operator funding and deposit-pool seed"
    fi

    # Always refresh port-based Smart Node env after launch/redeploy (ports change
    # on every enclave recreate even when chain contracts are new).
    if [[ "$SKIP_KURTOSIS" != "1" ]] && enclave_is_running; then
        if [[ -f "${ROOT_DIR}/deployments/odao-local.json" ]]; then
            generate_odao_config || log "warning: could not generate Smart Node draft config (ports?)"
        else
            log "Skipping Smart Node env generation (no odao-local.json yet; run without SKIP_ODAO)"
        fi
    fi

    print_summary "$provider_url"
}

main "$@"
