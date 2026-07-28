/**
 * Deploy and execute RocketUpgradeOneDotFive against a live RocketStorage
 * (Kurtosis / private nets).
 *
 * Expects a full v1.4-style (master) deployment already present in
 * deployments/latest.json, with guardian bootstrap mode still available.
 *
 * Flow:
 *   1. Deploy the 7 upgrade target contracts + RocketUpgradeOneDotFive
 *   2. upgrade.set(addresses, abis)
 *   3. rocketDAONodeTrustedUpgrade.bootstrapUpgrade(addContract, rocketUpgradeOneDotFive)
 *      (immediate; NOT RocketDAONodeTrusted.bootstrapUpgrade which only opens a pending proposal)
 *   4. upgrade.execute() as guardian
 *   5. Merge new addresses into deployments/latest.json
 *
 * Usage:
 *   PROVIDER_URL=... PRIVATE_KEY=0x...guardian... \
 *   ROCKET_STORAGE=0x... (optional; defaults to latest.json) \
 *   npx hardhat run scripts/devnet-7/deploy-upgrade-v1.5.js --network custom
 */

const fs = require('fs');
const path = require('path');
const pako = require('pako');
const hre = require('hardhat');
const { ethers } = hre;

const ROOT = path.resolve(__dirname, '../..');
const DEPLOYMENT_FILE = process.env.DEPLOYMENT_FILE
    || path.join(ROOT, 'deployments', 'latest.json');

function compressABI(abi) {
    return Buffer.from(pako.deflate(JSON.stringify(abi))).toString('base64');
}

function loadDeployment() {
    if (!fs.existsSync(DEPLOYMENT_FILE)) {
        throw new Error(`Missing deployment file: ${DEPLOYMENT_FILE}`);
    }
    return JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8'));
}

function saveDeployment(data) {
    const stamped = path.join(
        ROOT,
        'deployments',
        `upgrade_v1.5_${new Date().toISOString()}.json`,
    );
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(stamped, json, 'utf8');
    fs.writeFileSync(DEPLOYMENT_FILE, json, 'utf8');
    console.log(`  Wrote ${stamped}`);
    console.log(`  Updated ${DEPLOYMENT_FILE}`);
}

async function deployContract(name, args, signer) {
    console.log(`  - Deploying ${name}...`);
    const factory = await ethers.getContractFactory(name, signer);
    // Large contracts (RocketMegapoolDelegate) need ~68–80M gas under Glamsterdam
    // state-creation costs. Do NOT clamp to 16M — that OOGs and looks like a revert.
    // Prefer estimateGas * 1.25, capped at 90% of the current block gas limit.
    let opts = {};
    try {
        const deployTx = await factory.getDeployTransaction(...args);
        const estimated = await signer.estimateGas(deployTx);
        const buffered = (estimated * 125n) / 100n;
        const block = await signer.provider.getBlock('latest');
        const blockCap = (block.gasLimit * 90n) / 100n;
        // Optional hard ceiling from env (default 100M; block limit is usually 200M).
        const hardCap = BigInt(process.env.DEPLOY_GAS_LIMIT || process.env.TX_GAS_CAP || '100000000');
        let gasLimit = buffered > blockCap ? blockCap : buffered;
        if (gasLimit > hardCap) gasLimit = hardCap;
        // Floor: never go below estimate (or 20M for small contracts).
        if (gasLimit < estimated) gasLimit = estimated;
        opts = { gasLimit };
        console.log(`    estimateGas=${estimated} gasLimit=${gasLimit}`);
    } catch (e) {
        // estimateGas can fail for large CREATE under some geth builds; 80M works
        // for RocketMegapoolDelegate on Kurtosis glamsterdam-devnet-7.
        const fallback = BigInt(process.env.DEPLOY_GAS_FALLBACK || '80000000');
        console.log(`    (estimateGas failed: ${e.shortMessage || e.message}; using fallback ${fallback})`);
        opts = { gasLimit: fallback };
    }
    const contract = await factory.deploy(...args, opts);
    await contract.waitForDeployment();
    const address = await contract.getAddress();
    const code = await signer.provider.getCode(address);
    if (!code || code === '0x') {
        throw new Error(`${name} deployed to ${address} but has no code (OOG or constructor revert)`);
    }
    console.log(`    ${name} @ ${address} (code ${ (code.length - 2) / 2 } bytes)`);
    return contract;
}

async function main() {
    const deployment = loadDeployment();
    const rocketStorage = process.env.ROCKET_STORAGE
        || deployment.addresses.RocketStorage;
    if (!rocketStorage) {
        throw new Error('RocketStorage address missing (set ROCKET_STORAGE or latest.json)');
    }

    const [signer] = await ethers.getSigners();
    console.log('v1.5 upgrade (RocketUpgradeOneDotFive)');
    console.log(`  Deployer:       ${signer.address}`);
    console.log(`  RocketStorage:  ${rocketStorage}`);
    console.log(`  Provider:       ${process.env.PROVIDER_URL || '(hardhat network)'}`);

    // Genesis immutables for BeaconStateVerifier (this branch includes Fulu).
    const slotsPerHistoricalRoot = BigInt(process.env.SLOTS_PER_HISTORICAL_ROOT || '8192');
    const genesisBlockTimestamp = BigInt(process.env.GENESIS_BLOCK_TIMESTAMP || '0');
    const genesisValidatorRoot = process.env.GENESIS_VALIDATOR_ROOT
        || '0x0000000000000000000000000000000000000000000000000000000000000000';
    const beaconRoots = process.env.BEACON_ROOTS
        || '0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02';
    // Altair..Fulu (6 entries) — all at genesis for this Kurtosis schedule
    const forkSlotsRaw = (process.env.FORK_SLOTS || '0,0,0,0,0,0').split(',').map((s) => BigInt(s.trim()));
    if (forkSlotsRaw.length !== 6) {
        throw new Error(`FORK_SLOTS must have 6 values (Altair..Fulu); got ${forkSlotsRaw.length}`);
    }
    // EIP-7002 withdrawal request predeploy (mainnet/kurtosis system contract)
    const withdrawalRequest = process.env.WITHDRAWAL_REQUEST_PREDEPLOY
        || '0x00000961Ef480Eb55e80D19ad83579A64c007002';

    // --- Deploy upgrade targets (order matches RocketUpgradeOneDotFive.set) ---
    const megapoolDelegate = await deployContract(
        'RocketMegapoolDelegate',
        [rocketStorage, withdrawalRequest],
        signer,
    );
    const settingsMegapool = await deployContract(
        'RocketDAOProtocolSettingsMegapool',
        [rocketStorage],
        signer,
    );
    const networkRedemptions = await deployContract(
        'RocketNetworkRedemptions',
        [rocketStorage],
        signer,
    );
    const settingsNetwork = await deployContract(
        'RocketDAOProtocolSettingsNetwork',
        [rocketStorage],
        signer,
    );
    const beaconStateVerifier = await deployContract(
        'BeaconStateVerifier',
        [rocketStorage, slotsPerHistoricalRoot, forkSlotsRaw, beaconRoots, genesisBlockTimestamp, genesisValidatorRoot],
        signer,
    );
    const networkParticipation = await deployContract(
        'RocketNetworkParticipation',
        [rocketStorage],
        signer,
    );
    const networkExit = await deployContract(
        'RocketNetworkExit',
        [rocketStorage],
        signer,
    );
    const upgrade = await deployContract(
        'RocketUpgradeOneDotFive',
        [rocketStorage],
        signer,
    );

    const addresses = [
        await megapoolDelegate.getAddress(),
        await settingsMegapool.getAddress(),
        await networkRedemptions.getAddress(),
        await settingsNetwork.getAddress(),
        await beaconStateVerifier.getAddress(),
        await networkParticipation.getAddress(),
        await networkExit.getAddress(),
    ];
    const art = async (name) => {
        const a = await hre.artifacts.readArtifact(name);
        return compressABI(a.abi);
    };
    const abisFromArtifacts = [
        await art('RocketMegapoolDelegate'),
        await art('RocketDAOProtocolSettingsMegapool'),
        await art('RocketNetworkRedemptions'),
        await art('RocketDAOProtocolSettingsNetwork'),
        await art('BeaconStateVerifier'),
        await art('RocketNetworkParticipation'),
        await art('RocketNetworkExit'),
    ];

    console.log('  - upgrade.set(...)');
    let tx = await upgrade.set(addresses, abisFromArtifacts);
    await tx.wait();
    console.log(`    ok ${tx.hash}`);

    // Register upgrade contract immediately via RocketDAONodeTrustedUpgrade.bootstrapUpgrade.
    //
    // IMPORTANT: Do NOT use RocketDAONodeTrusted.bootstrapUpgrade here. On this branch that
    // path goes through proposalUpgrade → creates a *pending* upgrade with a security-council
    // veto delay (default 7 days via RPIP-60). It does not set contract.exists, so a subsequent
    // upgrade.execute() reverts with "Invalid or outdated network contract".
    // RocketDAONodeTrustedUpgrade.bootstrapUpgrade still applies the change immediately while
    // guardian bootstrap mode is enabled.
    const daoUpgradeAddr = deployment.addresses.RocketDAONodeTrustedUpgrade;
    if (!daoUpgradeAddr) {
        throw new Error('RocketDAONodeTrustedUpgrade missing from latest.json');
    }
    const daoUpgrade = await ethers.getContractAt('RocketDAONodeTrustedUpgrade', daoUpgradeAddr, signer);
    const upgradeAbi = compressABI((await hre.artifacts.readArtifact('RocketUpgradeOneDotFive')).abi);
    const upgradeAddr = await upgrade.getAddress();

    // Skip if a previous partial run already registered this (or another) upgrade contract.
    const storage = await ethers.getContractAt('RocketStorage', rocketStorage);
    const getAddress = storage.getFunction('getAddress(bytes32)');
    const getBool = storage.getFunction('getBool(bytes32)');
    const registered = await getAddress(
        ethers.keccak256(ethers.toUtf8Bytes('contract.addressrocketUpgradeOneDotFive')),
    );
    if (registered === ethers.ZeroAddress) {
        console.log('  - RocketDAONodeTrustedUpgrade.bootstrapUpgrade(addContract, rocketUpgradeOneDotFive)');
        tx = await daoUpgrade.bootstrapUpgrade(
            'addContract',
            'rocketUpgradeOneDotFive',
            upgradeAbi,
            upgradeAddr,
        );
        await tx.wait();
        console.log(`    ok ${tx.hash}`);
    } else {
        console.log(`  - rocketUpgradeOneDotFive already registered @ ${registered}`);
        if (registered.toLowerCase() !== upgradeAddr.toLowerCase()) {
            throw new Error(
                `rocketUpgradeOneDotFive already registered at ${registered}, but this deploy is ${upgradeAddr}`,
            );
        }
    }

    // Confirm contract.exists before execute (storage writes require network-contract caller)
    const exists = await getBool(ethers.keccak256(ethers.concat([
        ethers.toUtf8Bytes('contract.exists'),
        ethers.getBytes(upgradeAddr),
    ])));
    if (!exists) {
        throw new Error(`rocketUpgradeOneDotFive @ ${upgradeAddr} is not marked contract.exists`);
    }

    console.log('  - upgrade.execute()');
    // Large multi-contract upgrade; give plenty of gas on high-limit Kurtosis blocks
    tx = await upgrade.execute({ gasLimit: process.env.EXECUTE_GAS_LIMIT || 50_000_000 });
    await tx.wait();
    console.log(`    ok ${tx.hash}`);

    // Merge addresses into deployment record
    deployment.addresses.RocketMegapoolDelegate = addresses[0];
    deployment.addresses.RocketDAOProtocolSettingsMegapool = addresses[1];
    deployment.addresses.RocketNetworkRedemptions = addresses[2];
    deployment.addresses.RocketDAOProtocolSettingsNetwork = addresses[3];
    deployment.addresses.BeaconStateVerifier = addresses[4];
    deployment.addresses.RocketNetworkParticipation = addresses[5];
    deployment.addresses.RocketNetworkExit = addresses[6];
    deployment.addresses.RocketUpgradeOneDotFive = upgradeAddr;
    deployment.protocolVersion = '1.5';
    deployment.upgradeV15 = {
        executedAt: new Date().toISOString(),
        addresses: {
            RocketMegapoolDelegate: addresses[0],
            RocketDAOProtocolSettingsMegapool: addresses[1],
            RocketNetworkRedemptions: addresses[2],
            RocketDAOProtocolSettingsNetwork: addresses[3],
            BeaconStateVerifier: addresses[4],
            RocketNetworkParticipation: addresses[5],
            RocketNetworkExit: addresses[6],
            RocketUpgradeOneDotFive: upgradeAddr,
        },
    };
    saveDeployment(deployment);

    console.log('v1.5 upgrade complete');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
