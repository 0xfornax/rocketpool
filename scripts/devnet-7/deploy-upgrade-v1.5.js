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
 *   node scripts/devnet-7/deploy-upgrade-v1.5.js
 */

const fs = require('fs');
const path = require('path');
const pako = require('pako');
const { ethers } = require('ethers');
const { setPerformanceSettings } = require('./set-performance-settings');

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

const ARTIFACTS = {
    RocketMegapoolDelegate: 'RocketMegapoolDelegate.sol/RocketMegapoolDelegate.json',
    RocketMinipoolDelegate: 'RocketMinipoolDelegate.sol/RocketMinipoolDelegate.json',
    RocketMinipoolBase: 'RocketMinipoolBase.sol/RocketMinipoolBase.json',
    RocketMegapoolManager: 'RocketMegapoolManager.sol/RocketMegapoolManager.json',
    RocketDAOProtocolSettingsMegapool: 'RocketDAOProtocolSettingsMegapool.sol/RocketDAOProtocolSettingsMegapool.json',
    RocketNetworkRedemptions: 'RocketNetworkRedemptions.sol/RocketNetworkRedemptions.json',
    RocketDAOProtocolSettingsNetwork: 'RocketDAOProtocolSettingsNetwork.sol/RocketDAOProtocolSettingsNetwork.json',
    BeaconStateVerifier: 'BeaconStateVerifier.sol/BeaconStateVerifier.json',
    RocketNetworkParticipation: 'RocketNetworkParticipation.sol/RocketNetworkParticipation.json',
    RocketNetworkExit: 'RocketNetworkExit.sol/RocketNetworkExit.json',
    RocketNetworkPenalties: 'RocketNetworkPenalties.sol/RocketNetworkPenalties.json',
    RocketUpgradeOneDotFive: 'RocketUpgradeOneDotFive.sol/RocketUpgradeOneDotFive.json',
};

function loadArtifact(name) {
    const rel = ARTIFACTS[name];
    if (!rel) throw new Error(`unknown artifact ${name}`);
    const dirs = [
        process.env.V15_ARTIFACT_DIR,
        path.join(ROOT, 'artifacts-v15'),
        '/tmp/rp-v15-artifacts',
    ].filter(Boolean);
    let p = null;
    for (const dir of dirs) {
        const cand = path.join(dir, rel);
        if (fs.existsSync(cand)) {
            p = cand;
            break;
        }
    }
    if (!p) {
        throw new Error(`missing forge artifact ${name} (${rel}). Set V15_ARTIFACT_DIR or run forge build --out artifacts-v15`);
    }
    const art = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (art.bytecode && typeof art.bytecode === 'object' && art.bytecode.object) {
        art.bytecode = art.bytecode.object;
    }
    if (art.deployedBytecode && typeof art.deployedBytecode === 'object' && art.deployedBytecode.object) {
        art.deployedBytecode = art.deployedBytecode.object;
    }
    return art;
}

async function deployContract(name, args, signer) {
    console.log(`  - Deploying ${name}...`);
    const artifact = loadArtifact(name);
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
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

    const providerUrl = process.env.PROVIDER_URL || process.env.EL_HTTP;
    if (!providerUrl) throw new Error('PROVIDER_URL required');
    const key = process.env.PRIVATE_KEY
        || '0xbcdf20249abf0ed6d944c0288fad489e33f66b3960d9e6229c1cd214ed3bbe31';
    const privateKey = key.startsWith('0x') ? key : `0x${key}`;
    const provider = new ethers.JsonRpcProvider(providerUrl);
    const signer = new ethers.Wallet(privateKey, provider);
    const wallet = signer;
    console.log('v1.5 upgrade (RocketUpgradeOneDotFive)');
    console.log(`  Deployer:       ${signer.address}`);
    console.log(`  RocketStorage:  ${rocketStorage}`);
    console.log(`  Provider:       ${providerUrl}`);

    // Fork configuration for the upstream BeaconStateVerifier constructor.
    const slotsPerHistoricalRoot = BigInt(process.env.SLOTS_PER_HISTORICAL_ROOT || '8192');
    const beaconRoots = process.env.BEACON_ROOTS
        || '0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02';
    // Altair..Gloas (7 entries); Gloas activates at the configured slot.
    const forkSlotsRaw = (process.env.FORK_SLOTS || `0,0,0,0,0,0,${process.env.GLOAS_SLOT || '32'}`).split(',').map((s) => BigInt(s.trim()));
    if (forkSlotsRaw.length !== 7) {
        throw new Error(`FORK_SLOTS must have 7 values (Altair..Gloas); got ${forkSlotsRaw.length}`);
    }
    // EIP-7002 withdrawal request predeploy (mainnet/kurtosis system contract)
    const withdrawalRequest = process.env.WITHDRAWAL_REQUEST_PREDEPLOY
        || '0x00000961Ef480Eb55e80D19ad83579A64c007002';

    // --- Deploy upgrade targets (order matches RocketUpgradeOneDotFive.set / execute) ---
    const megapoolDelegate = await deployContract(
        'RocketMegapoolDelegate',
        [rocketStorage, withdrawalRequest],
        signer,
    );
    const minipoolDelegate = await deployContract('RocketMinipoolDelegate', [], signer);
    const megapoolManager = await deployContract('RocketMegapoolManager', [rocketStorage], signer);
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
        [rocketStorage, slotsPerHistoricalRoot, forkSlotsRaw, beaconRoots],
        signer,
    );
    const networkParticipation = await deployContract(
        'RocketNetworkParticipation',
        [rocketStorage],
        signer,
    );
    const networkExit = await deployContract(
        'RocketNetworkExit',
        [rocketStorage, withdrawalRequest],
        signer,
    );
    const networkPenalties = await deployContract(
        'RocketNetworkPenalties',
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
        await minipoolDelegate.getAddress(),
        await megapoolManager.getAddress(),
        await settingsMegapool.getAddress(),
        await networkRedemptions.getAddress(),
        await settingsNetwork.getAddress(),
        await beaconStateVerifier.getAddress(),
        await networkParticipation.getAddress(),
        await networkExit.getAddress(),
        await networkPenalties.getAddress(),
    ];
    const art = (name) => compressABI(loadArtifact(name).abi);
    const minipoolAbi = [
        ...loadArtifact('RocketMinipoolBase').abi,
        ...loadArtifact('RocketMinipoolDelegate').abi,
        { stateMutability: 'payable', type: 'fallback' },
        { stateMutability: 'payable', type: 'receive' },
    ];
    const abisFromArtifacts = [
        art('RocketMegapoolDelegate'),
        art('RocketMinipoolDelegate'),
        art('RocketMegapoolManager'),
        art('RocketDAOProtocolSettingsMegapool'),
        art('RocketNetworkRedemptions'),
        art('RocketDAOProtocolSettingsNetwork'),
        art('BeaconStateVerifier'),
        art('RocketNetworkParticipation'),
        art('RocketNetworkExit'),
        art('RocketNetworkPenalties'),
        compressABI(minipoolAbi),
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
    const daoUpgrade = new ethers.Contract(daoUpgradeAddr, [
        'function bootstrapUpgrade(string _type, string _name, string _contractAbi, address _contractAddress)',
    ], signer);
    const upgradeAbi = compressABI(loadArtifact('RocketUpgradeOneDotFive').abi);
    const upgradeAddr = await upgrade.getAddress();

    // Skip if a previous partial run already registered this (or another) upgrade contract.
    const storage = new ethers.Contract(rocketStorage, [
        'function getAddress(bytes32) view returns (address)',
        'function getBool(bytes32) view returns (bool)',
        'function getGuardian() view returns (address)',
    ], provider);
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
    tx = await upgrade.execute({ gasLimit: BigInt(process.env.EXECUTE_GAS_LIMIT || '50000000') });
    await tx.wait();
    console.log(`    ok ${tx.hash}`);

    // Merge addresses into deployment record
    deployment.addresses.RocketMegapoolDelegate = addresses[0];
    deployment.addresses.RocketMinipoolDelegate = addresses[1];
    deployment.addresses.RocketMegapoolManager = addresses[2];
    deployment.addresses.RocketDAOProtocolSettingsMegapool = addresses[3];
    deployment.addresses.RocketNetworkRedemptions = addresses[4];
    deployment.addresses.RocketDAOProtocolSettingsNetwork = addresses[5];
    deployment.addresses.BeaconStateVerifier = addresses[6];
    deployment.addresses.RocketNetworkParticipation = addresses[7];
    deployment.addresses.RocketNetworkExit = addresses[8];
    deployment.addresses.RocketNetworkPenalties = addresses[9];
    deployment.addresses.RocketUpgradeOneDotFive = upgradeAddr;
    deployment.protocolVersion = '1.5';
    deployment.upgradeV15 = {
        executedAt: new Date().toISOString(),
        addresses: {
            RocketMegapoolDelegate: addresses[0],
            RocketMinipoolDelegate: addresses[1],
            RocketMegapoolManager: addresses[2],
            RocketDAOProtocolSettingsMegapool: addresses[3],
            RocketNetworkRedemptions: addresses[4],
            RocketDAOProtocolSettingsNetwork: addresses[5],
            BeaconStateVerifier: addresses[6],
            RocketNetworkParticipation: addresses[7],
            RocketNetworkExit: addresses[8],
            RocketNetworkPenalties: addresses[9],
            RocketUpgradeOneDotFive: upgradeAddr,
        },
    };
    saveDeployment(deployment);

    // Ensure notify.threshold is safe for short kurtosis chains. Storage usually
    // persists from seed, but re-apply after upgrade so SKIP_SEED / re-inits
    // cannot leave mainnet default 112 (underflows when wd < threshold).
    // Guardrail min is 19 (RocketDAOProtocolSettingsMegapool.setSettingUint).
    {
        const notifyThreshold = BigInt(process.env.NOTIFY_THRESHOLD || '19');
        const daoProtocol = new ethers.Contract(
            deployment.addresses.RocketDAOProtocol,
            [
                'function bootstrapSettingUint(string settingContractName, string settingPath, uint256 value)',
                'function getBootstrapModeDisabled() view returns (bool)',
            ],
            wallet,
        );
        const settings = new ethers.Contract(
            deployment.addresses.RocketDAOProtocolSettingsMegapool,
            ['function getNotifyThreshold() view returns (uint256)'],
            provider,
        );
        const current = await settings.getNotifyThreshold();
        if (current === notifyThreshold) {
            console.log(`  - notify.threshold already ${current}`);
        } else if (await daoProtocol.getBootstrapModeDisabled()) {
            console.log(
                `  - WARNING: notify.threshold is ${current} (want ${notifyThreshold}) but bootstrap is closed; set manually`,
            );
        } else {
            console.log(`  - Setting notify.threshold ${current} → ${notifyThreshold}...`);
            tx = await daoProtocol.bootstrapSettingUint(
                'rocketDAOProtocolSettingsMegapool',
                'notify.threshold',
                notifyThreshold,
            );
            await tx.wait();
            console.log(`    ok ${tx.hash} (now ${(await settings.getNotifyThreshold()).toString()})`);
        }
    }

    // Apply devnet timings after execute(), which installs protocol defaults.
    await setPerformanceSettings(provider, wallet, rocketStorage);
    console.log('v1.5 upgrade complete');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
