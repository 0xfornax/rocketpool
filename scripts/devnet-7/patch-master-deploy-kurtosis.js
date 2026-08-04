/**
 * Patch a baseline-branch scripts/deploy.js to add (or replace) a Kurtosis chain
 * profile that reads genesis immutables from the environment.
 *
 * v1.4.1-dev BeaconStateVerifier uses uint64[7] fork slots
 * (Altair, Bellatrix, Capella, Deneb, Electra, Fulu, Gloas).
 *
 * Usage:
 *   node scripts/devnet-7/patch-master-deploy-kurtosis.js /path/to/worktree/scripts/deploy.js
 */
const fs = require('fs');

const target = process.argv[2];
if (!target || !fs.existsSync(target)) {
    console.error('Usage: node patch-master-deploy-kurtosis.js <path-to-baseline-deploy.js>');
    process.exit(1);
}

let src = fs.readFileSync(target, 'utf8');

// 7 slots: Altair..Gloas. On this Kurtosis schedule Altair–Fulu are at genesis (0);
// Gloas is delayed (default epoch 1 → slot 32; wall-clock depends on seconds_per_slot).
// Override via FORK_SLOTS_MASTER.
const kurtosisBlock = `
    // Local Kurtosis network (injected by scripts/devnet-7 for baseline deploy).
    // v1.4.1-dev BSV uses uint64[7] fork slots (Altair..Gloas).
    'kurtosis': {
        deployer: {
            depositAddress: '0x00000000219ab540356cBB839Cbe05303d7705Fa',
            fixedSupplyTokenAddress: null,
            rocketTokenRPLFixedSupply: null,
            genesisBlockTimestamp: (() => {
                const v = process.env.GENESIS_BLOCK_TIMESTAMP;
                return v ? BigInt(v) : 0n;
            })(),
            genesisValidatorRoot: process.env.GENESIS_VALIDATOR_ROOT
                || '0x0000000000000000000000000000000000000000000000000000000000000000',
            secondsPerSlot: (() => {
                const v = process.env.SECONDS_PER_SLOT;
                return v ? BigInt(v) : 12n;
            })(),
            slotsPerHistoricalRoot: (() => {
                const v = process.env.SLOTS_PER_HISTORICAL_ROOT;
                return v ? BigInt(v) : 8192n;
            })(),
            beaconRootsHistoryBufferLength: 8191n,
            beaconRoots: process.env.BEACON_ROOTS
                || '0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02',
            // Last slot is Gloas activation slot (= GLOAS_FORK_EPOCH * SLOTS_PER_EPOCH).
            // Must match network_params.yaml / live CL — wrong value → progressive vs list
            // SSZ path mismatch → "Invalid witness length" on stake proofs.
            forkSlots: (process.env.FORK_SLOTS_MASTER || '0,0,0,0,0,0,3200')
                .split(',')
                .map((s) => BigInt(s.trim())),
            deployThirdParty: false,
        },
        deployStorageHelper: true,
        mintDRPL: true,
        setDefaults: true,
    },
`;

// Remove any previous injected kurtosis profile so re-runs stay correct when BSV changes.
// Matches both single-quoted 'kurtosis' and double-quoted forms with trailing comma block.
const kurtosisRe = /[ \t]*\/\/ Local Kurtosis network[\s\S]*?'kurtosis'\s*:\s*\{[\s\S]*?\n[ \t]*\},?\n/;
const kurtosisReLoose = /[ \t]*'kurtosis'\s*:\s*\{[\s\S]*?deployStorageHelper[\s\S]*?\n[ \t]*\},?\n/;

if (kurtosisRe.test(src)) {
    src = src.replace(kurtosisRe, '');
    console.log('Removed previous kurtosis profile (comment-anchored)');
} else if (kurtosisReLoose.test(src)) {
    src = src.replace(kurtosisReLoose, '');
    console.log('Removed previous kurtosis profile');
}

if (!src.includes("'hardhat':")) {
    console.error('Could not find hardhat chain entry to insert kurtosis before');
    process.exit(1);
}
src = src.replace("'hardhat':", `${kurtosisBlock}    'hardhat':`);
fs.writeFileSync(target, src, 'utf8');
console.log(`Patched kurtosis profile into ${target}`);
