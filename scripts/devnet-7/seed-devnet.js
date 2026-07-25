/**
 * Seed a Kurtosis Rocket Pool deploy with operator funds and deposit-pool ETH.
 *
 * Always run after contracts are deployed (and preferably after oDAO bootstrap).
 *
 * Default actions:
 *   1. Send SEED_ETH (default 100) to SEED_ADDRESS
 *   2. Swap dummy RPL → RPL and transfer SEED_RPL (default 10000) to SEED_ADDRESS
 *   3. Deposit DEPOSIT_POOL_ETH (default 500) into RocketDepositPool
 *
 * Usage:
 *   PROVIDER_URL=http://127.0.0.1:PORT \
 *   PRIVATE_KEY=0x...guardian... \
 *   ODAO_PRIVATE_KEY=0x... (optional; used as ETH source if set) \
 *   SEED_ADDRESS=0x... \
 *   node scripts/devnet-7/seed-devnet.js
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '../..');
const DEPLOYMENT_FILE = process.env.DEPLOYMENT_FILE
    || path.join(ROOT, 'deployments', 'latest.json');

// ethereum-package prefunded accounts
const DEFAULT_GUARDIAN_KEY = '0xbcdf20249abf0ed6d944c0288fad489e33f66b3960d9e6229c1cd214ed3bbe31';
const DEFAULT_MEMBER_KEY = '0x39725efee3fb28614de3bacaffe4cc4bd8c436257e2c8bb887c4b5c4be45e76d';

// Operator node funded for local Smart Node / megapool work
const DEFAULT_SEED_ADDRESS = '0xc7EBC35C761bFbaE449973E226CE3295B9B7f996';
const DEFAULT_SEED_ETH = '100';
const DEFAULT_SEED_RPL = '10000';
const DEFAULT_DEPOSIT_POOL_ETH = '500';

const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)',
    'function approve(address spender, uint256 amount) returns (bool)',
];
const DUMMY_RPL_ABI = [
    ...ERC20_ABI,
    'function mint(address to, uint256 amount)',
];
const RPL_ABI = [
    ...ERC20_ABI,
    'function swapTokens(uint256 amount)',
];
const DEPOSIT_POOL_ABI = [
    'function deposit() payable',
    'function getBalance() view returns (uint256)',
];
const DAO_PROTOCOL_ABI = [
    'function bootstrapSettingUint(string settingContractName, string settingPath, uint256 value)',
    'function getBootstrapModeDisabled() view returns (bool)',
];
const DEPOSIT_SETTINGS_ABI = [
    'function getMaximumDepositPoolSize() view returns (uint256)',
    'function getDepositEnabled() view returns (bool)',
];

function normalizeKey(k) {
    if (!k) return k;
    return k.startsWith('0x') ? k : `0x${k}`;
}

function loadDeployment() {
    if (!fs.existsSync(DEPLOYMENT_FILE)) {
        throw new Error(`Deployment file missing: ${DEPLOYMENT_FILE}`);
    }
    return JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8'));
}

function addr(deployment, name) {
    const a = deployment.addresses && deployment.addresses[name];
    if (!a) throw new Error(`Missing address ${name} in ${DEPLOYMENT_FILE}`);
    return a;
}

async function main() {
    const providerUrl = process.env.PROVIDER_URL;
    if (!providerUrl) throw new Error('PROVIDER_URL is required');

    const guardianKey = normalizeKey(process.env.PRIVATE_KEY || DEFAULT_GUARDIAN_KEY);
    const ethSourceKey = normalizeKey(process.env.ODAO_PRIVATE_KEY || process.env.SEED_ETH_KEY || DEFAULT_MEMBER_KEY);
    const seedAddress = process.env.SEED_ADDRESS || DEFAULT_SEED_ADDRESS;
    const seedEth = ethers.parseEther(process.env.SEED_ETH || DEFAULT_SEED_ETH);
    const seedRpl = ethers.parseEther(process.env.SEED_RPL || DEFAULT_SEED_RPL);
    const depositPoolEth = ethers.parseEther(process.env.DEPOSIT_POOL_ETH || DEFAULT_DEPOSIT_POOL_ETH);

    const deployment = loadDeployment();
    const provider = new ethers.JsonRpcProvider(providerUrl);
    const guardian = new ethers.Wallet(guardianKey, provider);
    const ethSource = new ethers.Wallet(ethSourceKey, provider);

    const dummyRpl = new ethers.Contract(addr(deployment, 'RocketTokenDummyRPL'), DUMMY_RPL_ABI, guardian);
    const rpl = new ethers.Contract(addr(deployment, 'RocketTokenRPL'), RPL_ABI, guardian);
    const depositPool = new ethers.Contract(addr(deployment, 'RocketDepositPool'), DEPOSIT_POOL_ABI, guardian);
    const daoProtocol = new ethers.Contract(addr(deployment, 'RocketDAOProtocol'), DAO_PROTOCOL_ABI, guardian);
    const depositSettings = new ethers.Contract(
        addr(deployment, 'RocketDAOProtocolSettingsDeposit'),
        DEPOSIT_SETTINGS_ABI,
        provider,
    );

    console.log('Seed Kurtosis devnet');
    console.log(`  RPC:            ${providerUrl}`);
    console.log(`  Guardian:       ${guardian.address}`);
    console.log(`  ETH source:     ${ethSource.address}`);
    console.log(`  Seed address:   ${seedAddress}`);
    console.log(`  Seed ETH:       ${ethers.formatEther(seedEth)}`);
    console.log(`  Seed RPL:       ${ethers.formatEther(seedRpl)}`);
    console.log(`  Deposit pool:   ${ethers.formatEther(depositPoolEth)} ETH`);

    // --- 1) ETH to seed address ---
    {
        const bal = await provider.getBalance(ethSource.address);
        if (bal < seedEth) {
            throw new Error(`ETH source ${ethSource.address} has only ${ethers.formatEther(bal)} ETH; need ${ethers.formatEther(seedEth)}`);
        }
        console.log(`  - Sending ${ethers.formatEther(seedEth)} ETH to ${seedAddress}...`);
        const tx = await ethSource.sendTransaction({ to: seedAddress, value: seedEth });
        await tx.wait();
        console.log(`    ok ${tx.hash}`);
    }

    // --- 2) RPL to seed address (dummy → swap → transfer) ---
    {
        let dummyBal = await dummyRpl.balanceOf(guardian.address);
        if (dummyBal < seedRpl) {
            // Guardian is usually minted the full fixed supply at deploy; mint if artifact supports it.
            console.log(`  - Guardian DRPL low (${ethers.formatEther(dummyBal)}); attempting mint...`);
            try {
                const mintTx = await dummyRpl.mint(guardian.address, seedRpl);
                await mintTx.wait();
                dummyBal = await dummyRpl.balanceOf(guardian.address);
            } catch (e) {
                throw new Error(`Insufficient DRPL for seed and mint failed: ${e.shortMessage || e.message}`);
            }
        }
        console.log(`  - Approve DRPL for RPL swap (${ethers.formatEther(seedRpl)})...`);
        let tx = await dummyRpl.approve(await rpl.getAddress(), seedRpl);
        await tx.wait();
        console.log(`    ok ${tx.hash}`);

        console.log('  - Swap DRPL → RPL...');
        tx = await rpl.swapTokens(seedRpl);
        await tx.wait();
        console.log(`    ok ${tx.hash}`);

        console.log(`  - Transfer ${ethers.formatEther(seedRpl)} RPL to ${seedAddress}...`);
        tx = await rpl.transfer(seedAddress, seedRpl);
        await tx.wait();
        console.log(`    ok ${tx.hash}`);
    }

    // --- 3) User deposit into deposit pool ---
    {
        const enabled = await depositSettings.getDepositEnabled();
        if (!enabled) {
            throw new Error('deposit.enabled is false; cannot seed deposit pool');
        }
        const maxPool = await depositSettings.getMaximumDepositPoolSize();
        const poolBal = await depositPool.getBalance();
        const neededMax = poolBal + depositPoolEth;
        if (maxPool < neededMax) {
            const bootstrapDisabled = await daoProtocol.getBootstrapModeDisabled();
            if (bootstrapDisabled) {
                throw new Error(
                    `deposit.pool.maximum (${ethers.formatEther(maxPool)}) too low for +${ethers.formatEther(depositPoolEth)} ETH `
                    + `and bootstrap mode is closed`,
                );
            }
            // Raise cap to at least current + deposit + buffer (10k ETH)
            const newMax = neededMax > ethers.parseEther('10000') ? neededMax : ethers.parseEther('10000');
            console.log(`  - Raising deposit.pool.maximum to ${ethers.formatEther(newMax)} ETH...`);
            const tx = await daoProtocol.bootstrapSettingUint(
                'rocketDAOProtocolSettingsDeposit',
                'deposit.pool.maximum',
                newMax,
            );
            await tx.wait();
            console.log(`    ok ${tx.hash}`);
        }

        const gBal = await provider.getBalance(guardian.address);
        if (gBal < depositPoolEth) {
            throw new Error(`Guardian has only ${ethers.formatEther(gBal)} ETH; need ${ethers.formatEther(depositPoolEth)} for deposit pool`);
        }
        console.log(`  - Depositing ${ethers.formatEther(depositPoolEth)} ETH into RocketDepositPool...`);
        const tx = await depositPool.deposit({ value: depositPoolEth });
        await tx.wait();
        console.log(`    ok ${tx.hash}`);
        const after = await depositPool.getBalance();
        console.log(`    pool balance now ${ethers.formatEther(after)} ETH`);
    }

    const ethBal = await provider.getBalance(seedAddress);
    const rplBal = await rpl.balanceOf(seedAddress);
    console.log('Seed complete');
    console.log(`  ${seedAddress}`);
    console.log(`    ETH: ${ethers.formatEther(ethBal)}`);
    console.log(`    RPL: ${ethers.formatEther(rplBal)}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
