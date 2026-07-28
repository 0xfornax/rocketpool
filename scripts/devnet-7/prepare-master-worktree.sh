#!/usr/bin/env bash
# Create (or refresh) a git worktree of master for the baseline Kurtosis deploy.
# Compiles contracts in the worktree using the parent repo's node_modules.
#
# Usage:
#   ./scripts/devnet-7/prepare-master-worktree.sh
#   MASTER_REF=origin/master MASTER_WORKDIR=/tmp/rp-master ./scripts/devnet-7/prepare-master-worktree.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MASTER_REF="${MASTER_REF:-master}"
MASTER_WORKDIR="${MASTER_WORKDIR:-${ROOT_DIR}/.devnet-master}"

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

cd "$ROOT_DIR"

# Ensure ref exists
if ! git rev-parse --verify "$MASTER_REF" >/dev/null 2>&1; then
    die "git ref '${MASTER_REF}' not found (fetch origin/master?)"
fi

if [[ -d "$MASTER_WORKDIR" ]]; then
    log "Updating existing master worktree at ${MASTER_WORKDIR}"
    git -C "$MASTER_WORKDIR" fetch --quiet origin 2>/dev/null || true
    git -C "$MASTER_WORKDIR" checkout -f "$MASTER_REF"
    git -C "$MASTER_WORKDIR" reset --hard "$MASTER_REF"
else
    log "Creating master worktree ${MASTER_WORKDIR} @ ${MASTER_REF}"
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

# Patch deploy.js with Kurtosis profile (master BSV: 5 fork slots)
node "${SCRIPT_DIR}/patch-master-deploy-kurtosis.js" "${MASTER_WORKDIR}/scripts/deploy.js"

# Size-optimize Solidity settings so master artifacts fit EIP-170 (24 KiB) on
# pre-Gloas Fulu. Monorepo default is optimizer:false (too large for CREATE).
node "${SCRIPT_DIR}/optimize-master-hardhat-config.js" \
    "${MASTER_WORKDIR}/hardhat-common.config.js"

log "Compiling master contracts in worktree (optimizer runs=1, viaIR)"
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
console.log('All master deployed bytecodes <= '+LIMIT+' bytes');
"

log "Master worktree ready: ${MASTER_WORKDIR}"
printf '%s\n' "$MASTER_WORKDIR"
