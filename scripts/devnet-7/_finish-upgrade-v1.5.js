/**
 * Finish a partial v1.5 upgrade: bootstrap-register an already-deployed
 * RocketUpgradeOneDotFive and call execute(). Set UPGRADE_ADDRESS env.
 */
const fs = require('fs');
const path = require('path');
const pako = require('pako');
const hre = require('hardhat');
const { ethers } = hre;

const ROOT = path.resolve(__dirname, '../..');
const DEPLOYMENT_FILE = process.env.DEPLOYMENT_FILE || path.join(ROOT, 'deployments', 'latest.json');

function compressABI(abi) {
    return Buffer.from(pako.deflate(JSON.stringify(abi))).toString('base64');
}

async function main() {
    const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8'));
    const rocketStorage = process.env.ROCKET_STORAGE || deployment.addresses.RocketStorage;
    const upgradeAddr = process.env.UPGRADE_ADDRESS;
    if (!upgradeAddr) throw new Error('Set UPGRADE_ADDRESS to the deployed RocketUpgradeOneDotFive');

    const [signer] = await ethers.getSigners();
    console.log('Finish v1.5 upgrade');
    console.log('  Deployer:', signer.address);
    console.log('  Upgrade:', upgradeAddr);

    const storage = await ethers.getContractAt('RocketStorage', rocketStorage);
    const getAddress = storage.getFunction('getAddress(bytes32)');
    const getBool = storage.getFunction('getBool(bytes32)');
    const upgrade = await ethers.getContractAt('RocketUpgradeOneDotFive', upgradeAddr, signer);
    const daoUpgrade = await ethers.getContractAt(
        'RocketDAONodeTrustedUpgrade',
        deployment.addresses.RocketDAONodeTrustedUpgrade,
        signer,
    );

    const addresses = [];
    for (let i = 0; i < 7; i++) addresses.push(await upgrade.addresses(i));
    console.log('  targets:', addresses);

    const registered = await getAddress(
        ethers.keccak256(ethers.toUtf8Bytes('contract.addressrocketUpgradeOneDotFive')),
    );
    if (registered === ethers.ZeroAddress) {
        const upgradeAbi = compressABI((await hre.artifacts.readArtifact('RocketUpgradeOneDotFive')).abi);
        console.log('  - bootstrapUpgrade(addContract)...');
        const tx = await daoUpgrade.bootstrapUpgrade(
            'addContract',
            'rocketUpgradeOneDotFive',
            upgradeAbi,
            upgradeAddr,
        );
        await tx.wait();
        console.log('    ok', tx.hash);
    } else {
        console.log('  - already registered @', registered);
        if (registered.toLowerCase() !== upgradeAddr.toLowerCase()) {
            throw new Error(`registered ${registered} != ${upgradeAddr}`);
        }
    }

    const exists = await getBool(ethers.keccak256(ethers.concat([
        ethers.toUtf8Bytes('contract.exists'),
        ethers.getBytes(upgradeAddr),
    ])));
    console.log('  contract.exists', exists);
    if (!exists) throw new Error('still not registered');

    console.log('  - upgrade.execute()');
    const tx = await upgrade.execute({ gasLimit: 50_000_000 });
    const rc = await tx.wait();
    console.log('    ok', tx.hash, 'gas', rc.gasUsed.toString());

    // Merge into latest.json
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
    const stamped = path.join(ROOT, 'deployments', `upgrade_v1.5_${new Date().toISOString()}.json`);
    const json = JSON.stringify(deployment, null, 2);
    fs.writeFileSync(stamped, json);
    fs.writeFileSync(DEPLOYMENT_FILE, json);
    console.log('  Wrote', stamped);
    console.log('v1.5 upgrade complete');
}
main().catch((e) => { console.error(e); process.exit(1); });
