/**
 * Patch a baseline-branch scripts/deploy.js to add (or replace) a Kurtosis chain
 * profile that reads genesis immutables from the environment.
 *
 * Detects BSV fork-slot arity from the existing mainnet profile:
 *   - master / v1.4.0: uint64[5]  Altair..Electra
 *   - v1.4.1-dev:      uint64[7]  Altair..Gloas
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

function countForkSlots(text) {
    const m = text.match(/'mainnet'\s*:\s*\{[\s\S]*?forkSlots:\s*\[([\s\S]*?)\]/);
    const block = m ? m[1] : (text.match(/forkSlots:\s*\[([\s\S]*?)\]/) || [])[1];
    if (!block) return 5;
    const n = (block.match(/\d+n/g) || []).length;
    return n === 7 ? 7 : 5;
}

function defaultSlots(count) {
    if (count === 7) {
        const gloas = process.env.GLOAS_SLOT || '32000';
        return ['0', '0', '0', '0', '0', '0', gloas];
    }
    return Array(count).fill('0');
}

function resolveSlots(count) {
    const raw = process.env.FORK_SLOTS_MASTER;
    if (!raw) return defaultSlots(count);
    const slots = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (slots.length === count) return slots;
    if (slots.length > count) return slots.slice(0, count);
    console.warn(
        `FORK_SLOTS_MASTER has ${slots.length} values; baseline BSV wants ${count}. Using defaults.`,
    );
    return defaultSlots(count);
}

const forkCount = countForkSlots(src);
const slots = resolveSlots(forkCount);
const forkComment = forkCount === 7
    ? 'v1.4.1-dev BSV uses uint64[7] fork slots (Altair..Gloas).'
    : 'master / v1.4.0 BSV uses uint64[5] fork slots (Altair..Electra).';

const kurtosisBlock = `
    // Local Kurtosis network (injected by scripts/devnet-7 for baseline deploy).
    // ${forkComment}
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
            forkSlots: (process.env.FORK_SLOTS_MASTER || '${slots.join(',')}')
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
console.log(`Patched kurtosis profile into ${target} (BSV forkSlots=${forkCount}: ${slots.join(',')})`);
