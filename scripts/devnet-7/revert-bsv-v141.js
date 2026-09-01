/**
 * Replace on-chain beaconStateVerifier with the v1.4.1-dev implementation
 * (Gloas-capable progressive SSZ; uint64[7] fork slots).
 *
 * Deploys bytecode from the baseline worktree artifacts and registers it via
 * RocketDAONodeTrustedUpgrade.bootstrapUpgrade(upgradeContract, ...) while
 * guardian bootstrap mode is still open.
 *
 * Usage:
 *   PROVIDER_URL=http://127.0.0.1:32003 \
 *   PRIVATE_KEY=0xbcdf20249abf0ed6d944c0288fad489e33f66b3960d9e6229c1cd214ed3bbe31 \
 *   FORK_SLOTS_MASTER=0,0,0,0,0,0,3200 \   # Gloas @ epoch 100 (100*32); must match CL
 *   node scripts/devnet-7/revert-bsv-v141.js
 */

const fs = require('fs');
const path = require('path');
const pako = require('pako');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '../..');
const DEPLOYMENT_FILE = process.env.DEPLOYMENT_FILE
    || path.join(ROOT, 'deployments', 'latest.json');
const WORKTREE = process.env.MASTER_WORKDIR
    || path.join(ROOT, '.devnet-master');
const ARTIFACT = path.join(
    WORKTREE,
    'artifacts/contracts/contract/util/BeaconStateVerifier.sol/BeaconStateVerifier.json',
);

const DEFAULT_GUARDIAN_KEY = '0xbcdf20249abf0ed6d944c0288fad489e33f66b3960d9e6229c1cd214ed3bbe31';
const BEACON_ROOTS = process.env.BEACON_ROOTS
    || '0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02';

function compressABI(abi) {
    return Buffer.from(pako.deflate(JSON.stringify(abi))).toString('base64');
}

function loadJson(p) {
    if (!fs.existsSync(p)) throw new Error(`missing ${p}`);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function main() {
    const providerUrl = process.env.PROVIDER_URL || process.env.EL_HTTP;
    if (!providerUrl) throw new Error('PROVIDER_URL required');

    if (!fs.existsSync(ARTIFACT)) {
        throw new Error(
            `v1.4.1-dev BSV artifact missing at ${ARTIFACT}\n`
            + 'Run prepare-master-worktree.sh (MASTER_REF=v1.4.1-dev) first.',
        );
    }

    const deployment = loadJson(DEPLOYMENT_FILE);
    const artifact = loadJson(ARTIFACT);
    const rocketStorage = process.env.ROCKET_STORAGE
        || deployment.addresses.RocketStorage;
    const daoUpgradeAddr = deployment.addresses.RocketDAONodeTrustedUpgrade;
    if (!rocketStorage || !daoUpgradeAddr) {
        throw new Error('RocketStorage / RocketDAONodeTrustedUpgrade missing from latest.json');
    }

    // Default Gloas slot 3200 = epoch 100 @ 32 slots/epoch (current network_params).
    // Override when gloas_fork_epoch changes.
    const forkSlots = (process.env.FORK_SLOTS_MASTER || process.env.FORK_SLOTS || '0,0,0,0,0,0,3200')
        .split(',')
        .map((s) => BigInt(s.trim()));
    if (forkSlots.length !== 7) {
        throw new Error(`v1.4.1-dev BSV needs 7 fork slots (Altair..Gloas); got ${forkSlots.length}`);
    }

    const slotsPerHistoricalRoot = BigInt(process.env.SLOTS_PER_HISTORICAL_ROOT || '8192');
    const key = (process.env.PRIVATE_KEY || DEFAULT_GUARDIAN_KEY);
    const privateKey = key.startsWith('0x') ? key : `0x${key}`;

    const provider = new ethers.JsonRpcProvider(providerUrl);
    const wallet = new ethers.Wallet(privateKey, provider);

    console.log('Revert beaconStateVerifier → v1.4.1-dev');
    console.log(`  Deployer:     ${wallet.address}`);
    console.log(`  Storage:      ${rocketStorage}`);
    console.log(`  Fork slots:   ${forkSlots.map(String).join(',')}`);
    console.log(`  Artifact:     ${ARTIFACT}`);

    const storage = new ethers.Contract(rocketStorage, [
        'function getAddress(bytes32) view returns (address)',
        'function getGuardian() view returns (address)',
    ], provider);
    const getAddress = storage.getFunction('getAddress(bytes32)');
    const oldBsv = await getAddress(
        ethers.keccak256(ethers.toUtf8Bytes('contract.addressbeaconStateVerifier')),
    );
    console.log(`  Current BSV:  ${oldBsv}`);

    const guardian = await storage.getGuardian();
    if (guardian.toLowerCase() !== wallet.address.toLowerCase()) {
        throw new Error(`Deployer ${wallet.address} is not guardian ${guardian}`);
    }

    // Deploy
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
    const args = [rocketStorage, slotsPerHistoricalRoot, forkSlots, BEACON_ROOTS];

    let gasLimit = 25_000_000n;
    try {
        const deployTx = await factory.getDeployTransaction(...args);
        const estimated = await wallet.estimateGas(deployTx);
        gasLimit = (estimated * 125n) / 100n;
        console.log(`  estimateGas=${estimated} gasLimit=${gasLimit}`);
    } catch (e) {
        console.log(`  (estimateGas failed: ${e.shortMessage || e.message}; using ${gasLimit})`);
    }

    console.log('  - Deploying BeaconStateVerifier (v1.4.1-dev)...');
    const contract = await factory.deploy(...args, { gasLimit });
    await contract.waitForDeployment();
    const newAddr = await contract.getAddress();
    const code = await provider.getCode(newAddr);
    if (!code || code === '0x') {
        throw new Error(`deployed to ${newAddr} but no code`);
    }
    console.log(`    @ ${newAddr} (${(code.length - 2) / 2} bytes)`);

    // bootstrapUpgrade(upgradeContract)
    const daoUpgrade = new ethers.Contract(daoUpgradeAddr, [
        'function bootstrapUpgrade(string _type, string _name, string _contractAbi, address _contractAddress)',
    ], wallet);
    const compressedAbi = compressABI(artifact.abi);

    console.log('  - bootstrapUpgrade(upgradeContract, beaconStateVerifier)...');
    let txGas = 5_000_000n;
    try {
        const est = await daoUpgrade.bootstrapUpgrade.estimateGas(
            'upgradeContract',
            'beaconStateVerifier',
            compressedAbi,
            newAddr,
        );
        txGas = (est * 150n) / 100n;
    } catch (e) {
        console.log(`    estimate failed: ${e.reason || e.shortMessage || e.message}`);
        try {
            await daoUpgrade.bootstrapUpgrade.staticCall(
                'upgradeContract',
                'beaconStateVerifier',
                compressedAbi,
                newAddr,
            );
        } catch (e2) {
            throw new Error(`bootstrapUpgrade would revert: ${e2.reason || e2.shortMessage || e2.message}`);
        }
    }
    const tx = await daoUpgrade.bootstrapUpgrade(
        'upgradeContract',
        'beaconStateVerifier',
        compressedAbi,
        newAddr,
        { gasLimit: txGas },
    );
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error(`bootstrapUpgrade failed status=${rc.status}`);
    console.log(`    ok ${tx.hash}`);

    const registered = await getAddress(
        ethers.keccak256(ethers.toUtf8Bytes('contract.addressbeaconStateVerifier')),
    );
    if (registered.toLowerCase() !== newAddr.toLowerCase()) {
        throw new Error(`registration mismatch: storage has ${registered}, deployed ${newAddr}`);
    }
    console.log(`  Registered beaconStateVerifier → ${registered}`);

    // Update latest.json
    deployment.addresses.BeaconStateVerifier = newAddr;
    deployment.beaconStateVerifierSource = 'v1.4.1-dev';
    deployment.beaconStateVerifierRevertedAt = new Date().toISOString();
    deployment.beaconStateVerifierPrevious = oldBsv;
    const stamped = path.join(
        ROOT,
        'deployments',
        `bsv_v141_${new Date().toISOString()}.json`,
    );
    const json = JSON.stringify(deployment, null, 2);
    fs.writeFileSync(stamped, json);
    fs.writeFileSync(DEPLOYMENT_FILE, json);
    console.log(`  Updated ${DEPLOYMENT_FILE}`);
    console.log(`  Snapshot ${stamped}`);
    console.log('Done.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
