/**
 * Upgrade a live 1.4.0 (master) Kurtosis deploy to v1.4.1.
 *
 * Deploys from the v1.4.1-dev worktree artifacts:
 *   - BeaconStateVerifier (uint64[7] Altair..Gloas)
 *   - RocketMegapoolManager
 *   - RocketUpgradeOneDotFourDotOne
 * then guardian bootstrapUpgrade(addContract) + execute().
 *
 * Usage:
 *   MASTER_REF=v1.4.1-dev MASTER_WORKDIR=.devnet-v141 \
 *     ./scripts/devnet-7/prepare-master-worktree.sh
 *   PROVIDER_URL=http://127.0.0.1:32003 \
 *   FORK_SLOTS_MASTER=0,0,0,0,0,0,32000 \
 *     node scripts/devnet-7/deploy-upgrade-v1.4.1.js
 *
 * Or: ./scripts/devnet-7/upgrade-to-v1.4.1.sh
 */
const fs = require('fs');
const path = require('path');
const pako = require('pako');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '../..');
const DEPLOYMENT_FILE = process.env.DEPLOYMENT_FILE
    || path.join(ROOT, 'deployments', 'latest.json');
const WORKTREE = process.env.V141_WORKDIR
    || process.env.MASTER_WORKDIR
    || path.join(ROOT, '.devnet-v141');

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

function artifactPath(rel) {
    return path.join(WORKTREE, 'artifacts', rel);
}

function loadArtifact(rel, label) {
    const p = artifactPath(rel);
    if (!fs.existsSync(p)) {
        throw new Error(
            `${label} artifact missing at ${p}\n`
            + 'Run: MASTER_REF=v1.4.1-dev MASTER_WORKDIR=.devnet-v141 '
            + './scripts/devnet-7/prepare-master-worktree.sh',
        );
    }
    return loadJson(p);
}

async function deployFromArtifact(wallet, artifact, args, label) {
    console.log(`  - Deploying ${label}...`);
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
    let gasLimit = 25_000_000n;
    try {
        const deployTx = await factory.getDeployTransaction(...args);
        const estimated = await wallet.estimateGas(deployTx);
        gasLimit = (estimated * 125n) / 100n;
        console.log(`    estimateGas=${estimated} gasLimit=${gasLimit}`);
    } catch (e) {
        console.log(`    (estimateGas failed: ${e.shortMessage || e.message}; using ${gasLimit})`);
    }
    const contract = await factory.deploy(...args, { gasLimit });
    await contract.waitForDeployment();
    const address = await contract.getAddress();
    const code = await wallet.provider.getCode(address);
    if (!code || code === '0x') {
        throw new Error(`${label} deployed to ${address} but has no code`);
    }
    console.log(`    ${label} @ ${address} (${(code.length - 2) / 2} bytes)`);
    return { contract, address, artifact };
}

async function main() {
    const providerUrl = process.env.PROVIDER_URL || process.env.EL_HTTP;
    if (!providerUrl) throw new Error('PROVIDER_URL required');

    const bsvArt = loadArtifact(
        'contracts/contract/util/BeaconStateVerifier.sol/BeaconStateVerifier.json',
        'BeaconStateVerifier',
    );
    const mmArt = loadArtifact(
        'contracts/contract/megapool/RocketMegapoolManager.sol/RocketMegapoolManager.json',
        'RocketMegapoolManager',
    );
    const upArt = loadArtifact(
        'contracts/contract/upgrade/RocketUpgradeOneDotFourDotOne.sol/RocketUpgradeOneDotFourDotOne.json',
        'RocketUpgradeOneDotFourDotOne',
    );

    const deployment = loadJson(DEPLOYMENT_FILE);
    const rocketStorage = process.env.ROCKET_STORAGE
        || deployment.addresses.RocketStorage;
    const daoUpgradeAddr = deployment.addresses.RocketDAONodeTrustedUpgrade;
    if (!rocketStorage || !daoUpgradeAddr) {
        throw new Error('RocketStorage / RocketDAONodeTrustedUpgrade missing from latest.json');
    }

    const forkSlots = (process.env.FORK_SLOTS_MASTER || process.env.FORK_SLOTS || '0,0,0,0,0,0,32000')
        .split(',')
        .map((s) => BigInt(s.trim()));
    if (forkSlots.length !== 7) {
        throw new Error(`v1.4.1 BSV needs 7 fork slots (Altair..Gloas); got ${forkSlots.length}`);
    }
    const slotsPerHistoricalRoot = BigInt(process.env.SLOTS_PER_HISTORICAL_ROOT || '8192');

    const key = process.env.PRIVATE_KEY || DEFAULT_GUARDIAN_KEY;
    const privateKey = key.startsWith('0x') ? key : `0x${key}`;
    const provider = new ethers.JsonRpcProvider(providerUrl);
    const wallet = new ethers.Wallet(privateKey, provider);

    console.log('Upgrade 1.4.0 (master) → 1.4.1');
    console.log(`  Deployer:     ${wallet.address}`);
    console.log(`  Storage:      ${rocketStorage}`);
    console.log(`  Worktree:     ${WORKTREE}`);
    console.log(`  Fork slots:   ${forkSlots.map(String).join(',')}`);

    const storage = new ethers.Contract(rocketStorage, [
        'function getAddress(bytes32) view returns (address)',
        'function getGuardian() view returns (address)',
        'function getBool(bytes32) view returns (bool)',
        'function getString(bytes32) view returns (string)',
    ], provider);
    const getAddress = storage.getFunction('getAddress(bytes32)');
    const getBool = storage.getFunction('getBool(bytes32)');
    const getString = storage.getFunction('getString(bytes32)');

    const guardian = await storage.getGuardian();
    if (guardian.toLowerCase() !== wallet.address.toLowerCase()) {
        throw new Error(`Deployer ${wallet.address} is not guardian ${guardian}`);
    }

    const bsv = await deployFromArtifact(
        wallet,
        bsvArt,
        [rocketStorage, slotsPerHistoricalRoot, forkSlots, BEACON_ROOTS],
        'BeaconStateVerifier',
    );
    const mm = await deployFromArtifact(
        wallet,
        mmArt,
        [rocketStorage],
        'RocketMegapoolManager',
    );
    const upgrade = await deployFromArtifact(
        wallet,
        upArt,
        [
            rocketStorage,
            bsv.address,
            compressABI(bsv.artifact.abi),
            mm.address,
            compressABI(mm.artifact.abi),
        ],
        'RocketUpgradeOneDotFourDotOne',
    );

    const daoUpgrade = new ethers.Contract(daoUpgradeAddr, [
        'function bootstrapUpgrade(string _type, string _name, string _contractAbi, address _contractAddress)',
    ], wallet);

    const upgradeName = 'rocketUpgradeOneDotFourDotOne';
    const registered = await getAddress(
        ethers.keccak256(ethers.toUtf8Bytes(`contract.address${upgradeName}`)),
    );
    if (registered === ethers.ZeroAddress) {
        console.log(`  - bootstrapUpgrade(addContract, ${upgradeName})`);
        const tx = await daoUpgrade.bootstrapUpgrade(
            'addContract',
            upgradeName,
            compressABI(upArt.abi),
            upgrade.address,
        );
        const rc = await tx.wait();
        if (rc.status !== 1) throw new Error(`bootstrapUpgrade failed ${tx.hash}`);
        console.log(`    ok ${tx.hash}`);
    } else {
        console.log(`  - ${upgradeName} already registered @ ${registered}`);
        if (registered.toLowerCase() !== upgrade.address.toLowerCase()) {
            throw new Error(`already registered at ${registered}, this deploy is ${upgrade.address}`);
        }
    }

    const exists = await getBool(ethers.keccak256(ethers.concat([
        ethers.toUtf8Bytes('contract.exists'),
        ethers.getBytes(upgrade.address),
    ])));
    if (!exists) {
        throw new Error(`${upgradeName} @ ${upgrade.address} is not marked contract.exists`);
    }

    console.log('  - upgrade.execute()');
    const execute = upgrade.contract.getFunction('execute');
    const tx = await execute({ gasLimit: BigInt(process.env.EXECUTE_GAS_LIMIT || '8000000') });
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error(`execute failed ${tx.hash}`);
    console.log(`    ok ${tx.hash}`);

    const version = await getString(
        ethers.keccak256(ethers.toUtf8Bytes('protocol.version')),
    );
    console.log(`  protocol.version = ${version}`);

    deployment.addresses.BeaconStateVerifier = bsv.address;
    deployment.addresses.RocketMegapoolManager = mm.address;
    deployment.addresses.RocketUpgradeOneDotFourDotOne = upgrade.address;
    deployment.protocolVersion = '1.4.1';
    deployment.upgradeV141 = {
        executedAt: new Date().toISOString(),
        addresses: {
            BeaconStateVerifier: bsv.address,
            RocketMegapoolManager: mm.address,
            RocketUpgradeOneDotFourDotOne: upgrade.address,
        },
    };
    const stamped = path.join(ROOT, 'deployments', `upgrade_v1.4.1_${new Date().toISOString()}.json`);
    const json = JSON.stringify(deployment, null, 2);
    fs.writeFileSync(stamped, json);
    fs.writeFileSync(DEPLOYMENT_FILE, json);
    console.log(`  Updated ${DEPLOYMENT_FILE}`);
    console.log(`  Snapshot ${stamped}`);
    console.log('v1.4.1 upgrade complete');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
