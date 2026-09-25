#!/usr/bin/env bash
# Deploy v1.4.1-dev Rocket Pool contracts onto the locally synced Platåberget EL
# (rocketpool5 Geth at 127.0.0.1:8545, chain ID 7091047534).
#
# Does not launch Kurtosis and does not overwrite deployments/latest.json
# (that file is the Kurtosis/devnet artifact). Writes:
#   deployments/plataberget.json
#   deployments/networks-extra-plataberget.yml
#
# Usage:
#   ./scripts/devnet-7/deploy-plataberget.sh
#   MIN_ETH=2 ./scripts/devnet-7/deploy-plataberget.sh
#
# Env:
#   PROVIDER_URL     EL RPC (default: http://127.0.0.1:8545)
#   PRIVATE_KEY      Deployer key (default: PLATABERGET_PRIVATE_KEY from repo .env)
#   MIN_ETH          Abort if deployer balance is below this (default: 1)
#   SKIP_HELPERS=1   Skip Multicall2 / EthBalanceChecker / signer registry / TWAP
#   UPDATE_SMARTNODE=1  Also write networks-extra.yml into /srv/rocketpool5 and /srv/rocketpool6

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MASTER_WORKDIR="${MASTER_WORKDIR:-${ROOT_DIR}/.devnet-master}"
PROVIDER_URL="${PROVIDER_URL:-http://127.0.0.1:8545}"
DEPLOY_GAS_LIMIT="${DEPLOY_GAS_LIMIT:-150000000}"
MIN_ETH="${MIN_ETH:-1}"
SKIP_HELPERS="${SKIP_HELPERS:-0}"
UPDATE_SMARTNODE="${UPDATE_SMARTNODE:-0}"
CHAIN="${CHAIN:-plataberget}"

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

load_dotenv() {
    local file="$1"
    [[ -f "$file" ]] || return 0
    # Parse KEY=VALUE lines only; do not `source` (mnemonics contain spaces).
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ "$line" =~ ^[[:space:]]*$ ]] && continue
        if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
            local key="${BASH_REMATCH[1]}"
            local val="${BASH_REMATCH[2]}"
            val="${val%\"}"
            val="${val#\"}"
            val="${val%\'}"
            val="${val#\'}"
            printf -v "$key" '%s' "$val"
            export "$key"
        fi
    done < "$file"
}
load_dotenv "${ROOT_DIR}/.env"

PRIVATE_KEY="${PRIVATE_KEY:-${PLATABERGET_PRIVATE_KEY:-}}"
[[ -n "$PRIVATE_KEY" ]] || die "PRIVATE_KEY / PLATABERGET_PRIVATE_KEY is not set (see ${ROOT_DIR}/.env)"
[[ -d "$MASTER_WORKDIR" ]] || die "missing baseline worktree: ${MASTER_WORKDIR}"
[[ -f "${MASTER_WORKDIR}/scripts/deploy.js" ]] || die "missing ${MASTER_WORKDIR}/scripts/deploy.js"

require_cmd() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required"; }
require_cmd node
require_cmd npx
require_cmd curl

rpc() {
    local method="$1"
    local params="${2:-[]}"
    curl -sf --max-time 15 -X POST "$PROVIDER_URL" \
        -H 'content-type: application/json' \
        -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${method}\",\"params\":${params}}"
}

log "Checking Platåberget EL at ${PROVIDER_URL}"
chain_hex="$(rpc eth_chainId | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); if(!j.result) process.exit(2); process.stdout.write(String(parseInt(j.result,16)));})')"
[[ "$chain_hex" == "7091047534" ]] || die "unexpected chain id ${chain_hex} (want 7091047534 Platåberget). Is rocketpool5 Geth up?"

deployer_info="$(
    cd "$ROOT_DIR"
    PRIVATE_KEY="$PRIVATE_KEY" PROVIDER_URL="$PROVIDER_URL" node - <<'JS'
const { ethers } = require('ethers');
(async () => {
    const key = process.env.PRIVATE_KEY.startsWith('0x') ? process.env.PRIVATE_KEY : '0x' + process.env.PRIVATE_KEY;
    const provider = new ethers.JsonRpcProvider(process.env.PROVIDER_URL);
    const wallet = new ethers.Wallet(key, provider);
    const bal = await provider.getBalance(wallet.address);
    process.stdout.write(wallet.address + ' ' + ethers.formatEther(bal));
})().catch((e) => { console.error(e); process.exit(1); });
JS
)"
deployer_addr="${deployer_info%% *}"
deployer_eth="${deployer_info##* }"
log "Deployer: ${deployer_addr}"
log "Balance:  ${deployer_eth} ETH"

node -e "
const bal = Number('${deployer_eth}');
const min = Number('${MIN_ETH}');
if (!(bal >= min)) {
  console.error('error: deployer ' + '${deployer_addr}' + ' has ' + '${deployer_eth}' + ' ETH; need at least ' + min + ' ETH');
  console.error('Fund it from https://faucet.plataberget.ethpandaops.io then re-run.');
  process.exit(1);
}
"

mkdir -p "${ROOT_DIR}/deployments"
if [[ -f "${ROOT_DIR}/deployments/latest.json" && ! -f "${ROOT_DIR}/deployments/latest.kurtosis.bak.json" ]]; then
    cp -a "${ROOT_DIR}/deployments/latest.json" "${ROOT_DIR}/deployments/latest.kurtosis.bak.json"
    log "Backed up deployments/latest.json → latest.kurtosis.bak.json"
elif [[ -f "${ROOT_DIR}/deployments/latest.json" ]]; then
    cp -a "${ROOT_DIR}/deployments/latest.json" "${ROOT_DIR}/deployments/latest.pre-plataberget.json"
fi

# Ensure worktree deployments dir is the parent repo's (do not clobber kurtosis by accident after).
if [[ ! -L "${MASTER_WORKDIR}/deployments" ]]; then
    rm -rf "${MASTER_WORKDIR}/deployments"
    ln -sfn "${ROOT_DIR}/deployments" "${MASTER_WORKDIR}/deployments"
fi

log "Deploying v1.4.1-dev contracts from ${MASTER_WORKDIR} (CHAIN=${CHAIN})"
(
    cd "$MASTER_WORKDIR"
    export PROVIDER_URL
    export PRIVATE_KEY
    export CHAIN
    export DEPLOY_GAS_LIMIT
    npx hardhat run scripts/deploy.js --network custom
)

[[ -f "${ROOT_DIR}/deployments/latest.json" ]] || die "deploy did not write deployments/latest.json"
cp -a "${ROOT_DIR}/deployments/latest.json" "${ROOT_DIR}/deployments/plataberget.json"
# Restore Kurtosis latest.json so other scripts keep working.
if [[ -f "${ROOT_DIR}/deployments/latest.kurtosis.bak.json" ]]; then
    cp -a "${ROOT_DIR}/deployments/latest.kurtosis.bak.json" "${ROOT_DIR}/deployments/latest.json"
    log "Restored deployments/latest.json to Kurtosis backup"
fi
log "Wrote deployments/plataberget.json"

if [[ "$SKIP_HELPERS" != "1" ]]; then
    log "Deploying Smart Node helpers onto Platåberget"
    (
        cd "$ROOT_DIR"
        export PROVIDER_URL
        export PRIVATE_KEY
        export DEPLOY_GAS_LIMIT
        export DEPLOYMENT_FILE="${ROOT_DIR}/deployments/plataberget.json"
        node "${SCRIPT_DIR}/deploy-helpers.js"
    )
fi

extra_dests=(
    "${ROOT_DIR}/deployments/networks-extra-plataberget.yml"
)
if [[ "$UPDATE_SMARTNODE" == "1" ]]; then
    extra_dests+=("/srv/rocketpool5/networks-extra.yml" "/srv/rocketpool6/networks-extra.yml")
fi

node "${SCRIPT_DIR}/write-plataberget-networks-extra.js" \
    "${ROOT_DIR}/deployments/plataberget.json" \
    "${extra_dests[@]}"

log "Platåberget v1.4.1-dev deploy complete"
log "  deployment: ${ROOT_DIR}/deployments/plataberget.json"
log "  networks-extra: ${ROOT_DIR}/deployments/networks-extra-plataberget.yml"
log "  deployer: ${deployer_addr}"
