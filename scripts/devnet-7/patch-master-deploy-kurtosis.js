/**
 * Patch a master-branch scripts/deploy.js to add a Kurtosis chain profile that
 * reads genesis immutables from the environment (same vars as deploy.sh).
 *
 * Master BeaconStateVerifier uses uint64[5] fork slots (Altair..Electra).
 *
 * Usage:
 *   node scripts/devnet-7/patch-master-deploy-kurtosis.js /path/to/master/worktree/scripts/deploy.js
 */
const fs = require('fs');

const target = process.argv[2];
if (!target || !fs.existsSync(target)) {
    console.error('Usage: node patch-master-deploy-kurtosis.js <path-to-master-deploy.js>');
    process.exit(1);
}

let src = fs.readFileSync(target, 'utf8');
if (src.includes("'kurtosis':")) {
    console.log('kurtosis profile already present; skipping patch');
    process.exit(0);
}

const kurtosisBlock = `
    // Local Kurtosis network (injected by scripts/devnet-7 for master baseline deploy).
    // Master BSV uses 5 fork slots (Altair..Electra); Fulu/Gloas are CL-side only here.
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
            forkSlots: (process.env.FORK_SLOTS_MASTER || '0,0,0,0,0')
                .split(',')
                .map((s) => BigInt(s.trim())),
            deployThirdParty: false,
        },
        deployStorageHelper: true,
        mintDRPL: true,
        setDefaults: true,
    },
`;

// Insert before 'hardhat' entry
if (!src.includes("'hardhat':")) {
    console.error('Could not find hardhat chain entry to insert kurtosis before');
    process.exit(1);
}
src = src.replace("'hardhat':", `${kurtosisBlock}    'hardhat':`);
fs.writeFileSync(target, src, 'utf8');
console.log(`Patched kurtosis profile into ${target}`);
