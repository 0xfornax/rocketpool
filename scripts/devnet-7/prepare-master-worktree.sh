#!/usr/bin/env bash
# Create (or refresh) a git worktree of the pre-Gloas baseline for Kurtosis deploy.
# Default baseline ref is v1.4.1-dev (override with MASTER_REF).
# Compiles contracts in the worktree using the parent repo's node_modules.
#
# Usage:
#   ./scripts/devnet-7/prepare-master-worktree.sh
#   MASTER_REF=v1.4.1-dev MASTER_WORKDIR=/tmp/rp-baseline ./scripts/devnet-7/prepare-master-worktree.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MASTER_REF="${MASTER_REF:-v1.4.1-dev}"
MASTER_WORKDIR="${MASTER_WORKDIR:-${ROOT_DIR}/.devnet-master}"

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

cd "$ROOT_DIR"

# Ensure ref exists
if ! git rev-parse --verify "$MASTER_REF" >/dev/null 2>&1; then
    die "git ref '${MASTER_REF}' not found (try: git fetch origin ${MASTER_REF})"
fi

if [[ -d "$MASTER_WORKDIR" ]]; then
    log "Updating existing baseline worktree at ${MASTER_WORKDIR} → ${MASTER_REF}"
    git -C "$MASTER_WORKDIR" fetch --quiet origin 2>/dev/null || true
    git -C "$MASTER_WORKDIR" checkout -f "$MASTER_REF"
    git -C "$MASTER_WORKDIR" reset --hard "$MASTER_REF"
else
    log "Creating baseline worktree ${MASTER_WORKDIR} @ ${MASTER_REF}"
    # Remove stale registration if present
    git worktree prune 2>/dev/null || true
    git worktree add --force -B "devnet-master-worktree" "$MASTER_WORKDIR" "$MASTER_REF"
fi

# Reuse parent node_modules (same lockfile generation usually works)
if [[ ! -e "${MASTER_WORKDIR}/node_modules" ]]; then
    if [[ -d "${ROOT_DIR}/node_modules" ]]; then
        log "Symlinking node_modules from parent repo"
        ln -sfn "${ROOT_DIR}/node_modules" "${MASTER_WORKDIR}/node_modules"
    else
        die "node_modules missing in ${ROOT_DIR}; run npm install first"
    fi
fi

# Patch deploy.js with Kurtosis profile (v1.4.1-dev BSV: 7 fork slots Altair..Gloas)
node "${SCRIPT_DIR}/patch-master-deploy-kurtosis.js" "${MASTER_WORKDIR}/scripts/deploy.js"

# Short oDAO prices/balances submit interval (300s) + relax stock 1h minimum
# so seed-devnet can bootstrapSettingUint(300). Also rewards periods 28 → 4
# so claim interval = 4 × 300s = 20 minutes.
SETTINGS_DIR="${MASTER_WORKDIR}/contracts/contract/dao/protocol/settings"
SETTINGS_NETWORK_SOL="${SETTINGS_DIR}/RocketDAOProtocolSettingsNetwork.sol"
SETTINGS_REWARDS_SOL="${SETTINGS_DIR}/RocketDAOProtocolSettingsRewards.sol"
if [[ -f "$SETTINGS_NETWORK_SOL" ]]; then
    node "${SCRIPT_DIR}/patch-master-network-settings-kurtosis.js" \
        "$SETTINGS_NETWORK_SOL" \
        "$SETTINGS_REWARDS_SOL"
else
    log "warning: ${SETTINGS_NETWORK_SOL} missing; submit frequency stays mainnet defaults"
fi

# Size-optimize Solidity settings so baseline artifacts fit EIP-170 (24 KiB) on
# pre-Gloas Fulu. Monorepo default is optimizer:false (too large for CREATE).
node "${SCRIPT_DIR}/optimize-master-hardhat-config.js" \
    "${MASTER_WORKDIR}/hardhat-common.config.js"

log "Compiling baseline contracts (${MASTER_REF}) in worktree (optimizer runs=1, viaIR)"
(
    cd "$MASTER_WORKDIR"
    npx hardhat clean
    npx hardhat compile
)

# Fail fast if any deployed bytecode still exceeds 24 KiB
node -e "
const fs=require('fs'), path=require('path');
const LIMIT=24576;
const root=path.join('${MASTER_WORKDIR}','artifacts');
let bad=[];
function walk(d){
  for (const e of fs.readdirSync(d,{withFileTypes:true})) {
    const p=path.join(d,e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.json') && !e.name.endsWith('.dbg.json')) {
      try {
        const j=JSON.parse(fs.readFileSync(p,'utf8'));
        const bc=j.deployedBytecode||'';
        if (typeof bc==='string' && bc.startsWith('0x') && bc.length>10) {
          const n=(bc.length-2)/2;
          if (n>LIMIT) bad.push([(j.contractName||e.name), n]);
        }
      } catch {}
    }
  }
}
if (fs.existsSync(root)) walk(root);
if (bad.length) {
  console.error('ERROR: contracts still over '+LIMIT+' bytes after optimize:');
  for (const [n,s] of bad.sort((a,b)=>b[1]-a[1])) console.error('  '+s+'  '+n);
  process.exit(1);
}
console.log('All baseline deployed bytecodes <= '+LIMIT+' bytes');
"

log "Baseline worktree ready: ${MASTER_WORKDIR} @ ${MASTER_REF}"
printf '%s\n' "$MASTER_WORKDIR"
