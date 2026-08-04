/**
 * Deploy Smart Node helper contracts onto a live Kurtosis chain and merge
 * addresses into deployments/latest.json + odao-smartnode.env:
 *   - Multicall2
 *   - EthBalanceChecker
 *   - RocketSignerRegistry
 *   - UniswapOracleMock (RPL TWAP pool stub for watchtower submit-rpl-price)
 *
 * Usage:
 *   PROVIDER_URL=http://127.0.0.1:PORT PRIVATE_KEY=0x... \
 *     node scripts/devnet-7/deploy-helpers.js
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '../..');
const DEPLOYMENT_FILE = process.env.DEPLOYMENT_FILE
    || path.join(ROOT, 'deployments', 'latest.json');
const ENV_FILE = process.env.ODAO_ENV_FILE
    || path.join(ROOT, 'deployments', 'odao-smartnode.env');

const DEFAULT_GUARDIAN_KEY = '0xbcdf20249abf0ed6d944c0288fad489e33f66b3960d9e6229c1cd214ed3bbe31';

function normalizeKey(k) {
    if (!k) return k;
    return k.startsWith('0x') ? k : `0x${k}`;
}

function loadArtifact(name) {
    const map = {
        Multicall2: path.join(ROOT, 'artifacts/contracts/thirdparty/Multicall2/Multicall2.sol/Multicall2.json'),
        EthBalanceChecker: path.join(ROOT, 'artifacts/contracts/thirdparty/EthBalanceChecker/EthBalanceChecker.sol/EthBalanceChecker.json'),
        RocketSignerRegistry: path.join(ROOT, 'artifacts/contracts/thirdparty/RocketSignerRegistry/RocketSignerRegistry.sol/RocketSignerRegistry.json'),
        UniswapOracleMock: path.join(ROOT, 'artifacts/contracts/thirdparty/UniswapOracleMock/UniswapOracleMock.sol/UniswapOracleMock.json'),
    };
    const p = map[name];
    if (!p || !fs.existsSync(p)) {
        throw new Error(
            `Artifact not found for ${name}: ${p}\n`
            + `  Run: npx hardhat compile  (from the rocketpool repo root)`,
        );
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function deployOne(wallet, name) {
    const art = loadArtifact(name);
    const factory = new ethers.ContractFactory(art.abi, art.bytecode, wallet);
    console.log(`  - Deploying ${name}...`);
    // Let the provider estimate gas — fixed high limits OOG small constructors
    // when the estimate path is wrong, and fixed low limits also OOG.
    const contract = await factory.deploy();
    await contract.waitForDeployment();
    const address = await contract.getAddress();
    const tx = contract.deploymentTransaction();
    const code = await wallet.provider.getCode(address);
    if (!code || code === '0x') {
        throw new Error(`${name} deployed to ${address} but has empty code`);
    }
    console.log(`    ${name} -> ${address} @ ${tx ? tx.hash : 'n/a'}`);
    return address;
}

function upsertEnv(envPath, updates) {
    let text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    for (const [key, value] of Object.entries(updates)) {
        const re = new RegExp(`^${key}=.*$`, 'm');
        const line = `${key}=${value}`;
        if (re.test(text)) {
            text = text.replace(re, line);
        } else {
            if (text.length && !text.endsWith('\n')) text += '\n';
            text += line + '\n';
        }
    }
    fs.writeFileSync(envPath, text);
}

async function main() {
    const providerUrl = process.env.PROVIDER_URL || 'http://127.0.0.1:8545';
    const key = normalizeKey(process.env.PRIVATE_KEY || DEFAULT_GUARDIAN_KEY);
    const provider = new ethers.JsonRpcProvider(providerUrl);
    const wallet = new ethers.Wallet(key, provider);

    console.log('Deploy Smart Node helpers');
    console.log(`  RPC:      ${providerUrl}`);
    console.log(`  Deployer: ${wallet.address}`);

    if (!fs.existsSync(DEPLOYMENT_FILE)) {
        throw new Error(`Missing ${DEPLOYMENT_FILE}`);
    }
    const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8'));
    deployment.addresses = deployment.addresses || {};

    // Skip if already present and code exists
    async function hasCode(addr) {
        if (!addr) return false;
        const code = await provider.getCode(addr);
        return code && code !== '0x';
    }

    let multicall = deployment.addresses.Multicall2;
    let balanceChecker = deployment.addresses.EthBalanceChecker;
    let signerRegistry = deployment.addresses.RocketSignerRegistry;
    // TWAP pool address used by Smart Node watchtower for RPL price submissions.
    let twapPool = deployment.addresses.UniswapOracleMock
        || deployment.addresses.RplTwapPool
        || deployment.addresses.RPLTwapPool;

    if (!(await hasCode(multicall))) {
        multicall = await deployOne(wallet, 'Multicall2');
        deployment.addresses.Multicall2 = multicall;
    } else {
        console.log(`  Multicall2 already at ${multicall}`);
    }

    if (!(await hasCode(balanceChecker))) {
        balanceChecker = await deployOne(wallet, 'EthBalanceChecker');
        deployment.addresses.EthBalanceChecker = balanceChecker;
    } else {
        console.log(`  EthBalanceChecker already at ${balanceChecker}`);
    }

    if (!(await hasCode(signerRegistry))) {
        signerRegistry = await deployOne(wallet, 'RocketSignerRegistry');
        deployment.addresses.RocketSignerRegistry = signerRegistry;
    } else {
        console.log(`  RocketSignerRegistry already at ${signerRegistry}`);
    }

    if (!(await hasCode(twapPool))) {
        twapPool = await deployOne(wallet, 'UniswapOracleMock');
        deployment.addresses.UniswapOracleMock = twapPool;
        deployment.addresses.RplTwapPool = twapPool;
    } else {
        console.log(`  UniswapOracleMock (RPL TWAP) already at ${twapPool}`);
        deployment.addresses.UniswapOracleMock = twapPool;
        deployment.addresses.RplTwapPool = twapPool;
    }

    fs.writeFileSync(DEPLOYMENT_FILE, JSON.stringify(deployment, null, 2));
    // Also mirror into a dated file if latest is a symlink-like copy
    const latestMirror = path.join(ROOT, 'deployments', 'helpers_' + new Date().toISOString() + '.json');
    fs.writeFileSync(latestMirror, JSON.stringify({
        Multicall2: multicall,
        EthBalanceChecker: balanceChecker,
        RocketSignerRegistry: signerRegistry,
        UniswapOracleMock: twapPool,
        RplTwapPool: twapPool,
        chain: deployment.chain,
        providerUrl,
    }, null, 2));

    upsertEnv(ENV_FILE, {
        MULTICALL_ADDRESS: multicall,
        ROCKETPOOL_DEVNET_MULTICALL_ADDRESS: multicall,
        BALANCE_BATCHER_ADDRESS: balanceChecker,
        ROCKETPOOL_DEVNET_BALANCE_BATCHER_ADDRESS: balanceChecker,
        SIGNER_REGISTRY_ADDRESS: signerRegistry,
        ROCKETPOOL_DEVNET_SIGNER_REGISTRY_ADDRESS: signerRegistry,
        RPL_TWAP_POOL_ADDRESS: twapPool,
        ROCKETPOOL_DEVNET_RPL_TWAP_POOL_ADDRESS: twapPool,
    });

    console.log('  Updated', DEPLOYMENT_FILE);
    console.log('  Updated', ENV_FILE);
    console.log('  Multicall2:            ', multicall);
    console.log('  EthBalanceChecker:     ', balanceChecker);
    console.log('  RocketSignerRegistry:  ', signerRegistry);
    console.log('  UniswapOracleMock/TWAP:', twapPool);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
