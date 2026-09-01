/**
 * Set rocketDAOProtocolSettingsSecurity upgrade.delay on a live Kurtosis chain
 * and rebase any already-pending RocketDAONodeTrustedUpgrade proposals so their
 * stored end times use the new delay (the end timestamp is snapshotted at
 * proposalUpgrade, so changing the setting alone does not shorten them).
 *
 * Stock SettingsSecurity requires upgrade.delay >= 1 day, so guardian
 * bootstrapSettingUint(10 minutes) reverts. This script writes storage via a
 * tiny helper registered with RocketDAONodeTrustedUpgrade.bootstrapUpgrade
 * (immediate while oDAO bootstrap is still open).
 *
 * Usage:
 *   PROVIDER_URL=http://127.0.0.1:32003 node scripts/devnet-7/set-upgrade-delay.js
 *
 * Env:
 *   UPGRADE_DELAY_SECS  (default 600 = 10 minutes)
 */

const fs = require('fs');
const path = require('path');
const pako = require('pako');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '../..');
const DEPLOYMENT_FILE = process.env.DEPLOYMENT_FILE
    || path.join(ROOT, 'deployments', 'latest.json');
const DEFAULT_GUARDIAN_KEY = '0xbcdf20249abf0ed6d944c0288fad489e33f66b3960d9e6229c1cd214ed3bbe31';
const HELPER_NAME = 'rocketDevnetStorageWriter';
const DELAY_SECS = BigInt(process.env.UPGRADE_DELAY_SECS || '600');

const WRITER_SOURCE = `// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.0;
interface IStore { function setUint(bytes32, uint256) external; }
contract RocketDevnetStorageWriter {
    IStore public immutable store;
    address public immutable guardian;
    constructor(address s, address g) { store = IStore(s); guardian = g; }
    function setUint(bytes32 k, uint256 v) external {
        require(msg.sender == guardian, "not guardian");
        store.setUint(k, v);
    }
}
`;

function compressABI(abi) {
    return Buffer.from(pako.deflate(JSON.stringify(abi))).toString('base64');
}

function loadDeployment() {
    if (!fs.existsSync(DEPLOYMENT_FILE)) {
        throw new Error(`Missing ${DEPLOYMENT_FILE}`);
    }
    return JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8'));
}

function addr(deployment, name) {
    const a = deployment.addresses && deployment.addresses[name];
    if (!a) throw new Error(`Deployment missing ${name}`);
    return a;
}

function settingUintKey(namespace, settingPath) {
    const ns = ethers.keccak256(ethers.toUtf8Bytes(`dao.protocol.setting.${namespace}`));
    return ethers.keccak256(ethers.concat([ethers.getBytes(ns), ethers.toUtf8Bytes(settingPath)]));
}

function upgradeEndKey(id) {
    return ethers.keccak256(ethers.concat([
        ethers.toUtf8Bytes('dao.upgrade.end'),
        ethers.zeroPadValue(ethers.toBeHex(id), 32),
    ]));
}

function compileWriter() {
    const solcPath = path.join(ROOT, 'node_modules/hardhat/node_modules/solc');
    const solc = require(solcPath);
    const input = {
        language: 'Solidity',
        sources: { 'RocketDevnetStorageWriter.sol': { content: WRITER_SOURCE } },
        settings: {
            optimizer: { enabled: true, runs: 1 },
            outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } },
        },
    };
    const out = JSON.parse(solc.compile(JSON.stringify(input)));
    if (out.errors) {
        const fatal = out.errors.filter((e) => e.severity === 'error');
        if (fatal.length) {
            throw new Error(fatal.map((e) => e.formattedMessage || e.message).join('\n'));
        }
    }
    const c = out.contracts['RocketDevnetStorageWriter.sol'].RocketDevnetStorageWriter;
    if (!c || !c.evm || !c.evm.bytecode || !c.evm.bytecode.object) {
        throw new Error('solc produced no bytecode for RocketDevnetStorageWriter');
    }
    return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

async function main() {
    const providerUrl = process.env.PROVIDER_URL || 'http://127.0.0.1:32003';
    const key = process.env.PRIVATE_KEY || DEFAULT_GUARDIAN_KEY;
    const privateKey = key.startsWith('0x') ? key : `0x${key}`;
    const deployment = loadDeployment();
    const provider = new ethers.JsonRpcProvider(providerUrl);
    const guardian = new ethers.Wallet(privateKey, provider);
    const rocketStorage = addr(deployment, 'RocketStorage');

    const settings = new ethers.Contract(
        addr(deployment, 'RocketDAOProtocolSettingsSecurity'),
        ['function getUpgradeDelay() view returns (uint256)'],
        provider,
    );
    const storage = new ethers.Contract(rocketStorage, [
        'function getAddress(bytes32) view returns (address)',
        'function getUint(bytes32) view returns (uint256)',
        'function getBool(bytes32) view returns (bool)',
    ], provider);
    // ethers v6 Contract also has Addressable.getAddress() — pin the storage getter.
    const getAddress = storage.getFunction('getAddress(bytes32)');
    const getUint = storage.getFunction('getUint(bytes32)');
    const getBool = storage.getFunction('getBool(bytes32)');
    const daoUpgrade = new ethers.Contract(
        addr(deployment, 'RocketDAONodeTrustedUpgrade'),
        [
            'function bootstrapUpgrade(string _type, string _name, string _contractAbi, address _contractAddress)',
            'function getTotal() view returns (uint256)',
            'function getEnd(uint256) view returns (uint256)',
            'function getState(uint256) view returns (uint8)',
            'function getName(uint256) view returns (string)',
        ],
        guardian,
    );

    console.log('Set oDAO upgrade.delay');
    console.log(`  RPC:      ${providerUrl}`);
    console.log(`  Guardian: ${guardian.address}`);
    console.log(`  Want:     ${DELAY_SECS}s`);

    const current = await settings.getUpgradeDelay();
    console.log(`  Current:  ${current}s`);

    const delayKey = settingUintKey('security', 'upgrade.delay');
    const stored = await getUint(delayKey);
    if (stored !== current) {
        throw new Error(`storage key mismatch: getUpgradeDelay=${current} getUint=${stored} key=${delayKey}`);
    }

    const nameKey = ethers.keccak256(ethers.toUtf8Bytes(`contract.address${HELPER_NAME}`));
    let helperAddr = await getAddress(nameKey);
    let writerAbi;

    if (helperAddr === ethers.ZeroAddress) {
        const compiled = compileWriter();
        writerAbi = compiled.abi;
        console.log('  - Deploying RocketDevnetStorageWriter...');
        const factory = new ethers.ContractFactory(compiled.abi, compiled.bytecode, guardian);
        const helper = await factory.deploy(rocketStorage, guardian.address);
        await helper.waitForDeployment();
        helperAddr = await helper.getAddress();
        const code = await provider.getCode(helperAddr);
        if (!code || code === '0x') {
            throw new Error(`helper deployed to ${helperAddr} but has no code`);
        }
        console.log(`    ${helperAddr}`);
        console.log(`  - bootstrapUpgrade(addContract, ${HELPER_NAME})...`);
        const tx = await daoUpgrade.bootstrapUpgrade(
            'addContract',
            HELPER_NAME,
            compressABI(compiled.abi),
            helperAddr,
        );
        const rc = await tx.wait();
        if (rc.status !== 1) throw new Error(`bootstrapUpgrade failed ${tx.hash}`);
        console.log(`    ok ${tx.hash}`);
        const exists = await getBool(ethers.keccak256(ethers.concat([
            ethers.toUtf8Bytes('contract.exists'),
            ethers.getBytes(helperAddr),
        ])));
        if (!exists) throw new Error(`helper ${helperAddr} is not marked contract.exists`);
    } else {
        console.log(`  - Reusing ${HELPER_NAME} @ ${helperAddr}`);
        writerAbi = compileWriter().abi;
    }

    const writer = new ethers.Contract(helperAddr, writerAbi, guardian);

    if (current !== DELAY_SECS) {
        console.log(`  - setUint(upgrade.delay) ${current}s → ${DELAY_SECS}s...`);
        const tx = await writer.setUint(delayKey, DELAY_SECS);
        const rc = await tx.wait();
        if (rc.status !== 1) throw new Error(`setUint upgrade.delay failed ${tx.hash}`);
        console.log(`    ok ${tx.hash}`);
    } else {
        console.log('  - upgrade.delay already at target');
    }

    const after = await settings.getUpgradeDelay();
    if (after !== DELAY_SECS) {
        throw new Error(`upgrade.delay still ${after}s after write`);
    }
    console.log(`  upgrade.delay now ${after}s`);

    // Rebase pending upgrades whose end was snapshotted with the old delay.
    const total = await daoUpgrade.getTotal();
    const now = BigInt((await provider.getBlock('latest')).timestamp);
    const states = ['Pending', 'Succeeded', 'Vetoed', 'Executed'];
    for (let id = 1n; id <= total; id++) {
        const state = Number(await daoUpgrade.getState(id));
        const name = await daoUpgrade.getName(id);
        const end = await daoUpgrade.getEnd(id);
        if (state !== 0) {
            console.log(`  - upgrade #${id} ${name} state=${states[state] || state}; leave end=${end}`);
            continue;
        }
        // Reconstruct created time from the previously stored delay (current was
        // the old value if we just changed it; if already at target, use `current`).
        const oldDelay = current === DELAY_SECS ? current : current;
        const created = end > oldDelay ? end - oldDelay : 0n;
        let newEnd = created + DELAY_SECS;
        if (newEnd < now) {
            // 10-minute window already elapsed since creation — make it executable now.
            newEnd = now;
        }
        if (newEnd === end) {
            console.log(`  - upgrade #${id} ${name} end already ${end}`);
            continue;
        }
        console.log(
            `  - rebase upgrade #${id} ${name} end ${end} → ${newEnd} `
            + `(created ${created}, remaining ${newEnd > now ? (newEnd - now).toString() : '0'}s)`,
        );
        const tx = await writer.setUint(upgradeEndKey(id), newEnd);
        const rc = await tx.wait();
        if (rc.status !== 1) throw new Error(`setUint upgrade end #${id} failed ${tx.hash}`);
        const afterEnd = await daoUpgrade.getEnd(id);
        const afterState = Number(await daoUpgrade.getState(id));
        console.log(`    ok ${tx.hash} end=${afterEnd} state=${states[afterState] || afterState}`);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
