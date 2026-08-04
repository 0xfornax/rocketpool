/**
 * Deposit RPL into RocketVault assigned to rocketRewardsPool so
 * RocketRewardsPool.getPendingRPLRewards() is non-zero.
 *
 * Needed on Kurtosis when the rewards claim interval is shorter than the
 * hardcoded 1-day RPL inflation interval: tree generation reverts with
 * "there are no pending RPL rewards" until either inflation mints or the
 * vault is pre-funded.
 *
 * Usage:
 *   PROVIDER_URL=http://127.0.0.1:32003 \
 *   PRIVATE_KEY=0x... (holder of RPL; default guardian) \
 *   REWARDS_POOL_RPL=1000 \
 *   node scripts/devnet-7/fund-rewards-pool.js
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '../..');
const DEPLOYMENT_FILE = process.env.DEPLOYMENT_FILE
    || path.join(ROOT, 'deployments', 'latest.json');
const DEFAULT_GUARDIAN_KEY = '0xbcdf20249abf0ed6d944c0288fad489e33f66b3960d9e6229c1cd214ed3bbe31';
const DEFAULT_REWARDS_POOL_RPL = '1000';

function normalizeKey(k) {
    if (!k) return k;
    return k.startsWith('0x') ? k : `0x${k}`;
}

function addr(deployment, name) {
    const a = deployment.addresses && deployment.addresses[name];
    if (!a) throw new Error(`Missing address ${name} in ${DEPLOYMENT_FILE}`);
    return a;
}

async function main() {
    const providerUrl = process.env.PROVIDER_URL;
    if (!providerUrl) throw new Error('PROVIDER_URL is required');

    const key = normalizeKey(process.env.PRIVATE_KEY || DEFAULT_GUARDIAN_KEY);
    const amount = ethers.parseEther(process.env.REWARDS_POOL_RPL || DEFAULT_REWARDS_POOL_RPL);
    const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8'));
    const provider = new ethers.JsonRpcProvider(providerUrl);
    const wallet = new ethers.Wallet(key, provider);

    const rpl = new ethers.Contract(addr(deployment, 'RocketTokenRPL'), [
        'function balanceOf(address) view returns (uint256)',
        'function approve(address,uint256) returns (bool)',
        'function swapTokens(uint256 amount)',
    ], wallet);
    const dummyRpl = new ethers.Contract(addr(deployment, 'RocketTokenDummyRPL'), [
        'function balanceOf(address) view returns (uint256)',
        'function approve(address,uint256) returns (bool)',
        'function mint(address to, uint256 amount)',
    ], wallet);
    const vault = new ethers.Contract(addr(deployment, 'RocketVault'), [
        'function balanceOfToken(string,address) view returns (uint256)',
        'function depositToken(string,address,uint256)',
    ], wallet);
    const rewardsPool = new ethers.Contract(addr(deployment, 'RocketRewardsPool'), [
        'function getPendingRPLRewards() view returns (uint256)',
        'function getRPLBalance() view returns (uint256)',
    ], provider);

    const rplAddr = await rpl.getAddress();
    const beforePool = await rewardsPool.getRPLBalance();
    const beforePending = await rewardsPool.getPendingRPLRewards();
    console.log(`Funder:  ${wallet.address}`);
    console.log(`Before:  pool=${ethers.formatEther(beforePool)} pending=${ethers.formatEther(beforePending)}`);

    if (beforePending >= amount) {
        console.log(`Already funded (≥ ${ethers.formatEther(amount)} pending); nothing to do.`);
        return;
    }

    const need = amount > beforePool ? amount - beforePool : 0n;
    if (need === 0n) {
        console.log('Pool balance already sufficient.');
        return;
    }

    let rplBal = await rpl.balanceOf(wallet.address);
    if (rplBal < need) {
        const deficit = need - rplBal;
        console.log(`RPL low (${ethers.formatEther(rplBal)}); swapping ${ethers.formatEther(deficit)} DRPL→RPL...`);
        let dummyBal = await dummyRpl.balanceOf(wallet.address);
        if (dummyBal < deficit) {
            try {
                const mintTx = await dummyRpl.mint(wallet.address, deficit);
                await mintTx.wait();
            } catch (e) {
                throw new Error(`Need ${ethers.formatEther(deficit)} more RPL; DRPL mint failed: ${e.shortMessage || e.message}`);
            }
        }
        let tx = await dummyRpl.approve(rplAddr, deficit);
        await tx.wait();
        tx = await rpl.swapTokens(deficit);
        await tx.wait();
        rplBal = await rpl.balanceOf(wallet.address);
    }

    console.log(`Depositing ${ethers.formatEther(need)} RPL → vault(rocketRewardsPool)...`);
    let tx = await rpl.approve(await vault.getAddress(), need);
    await tx.wait();
    tx = await vault.depositToken('rocketRewardsPool', rplAddr, need);
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error(`depositToken failed status=${rc.status}`);

    const afterPool = await rewardsPool.getRPLBalance();
    const afterPending = await rewardsPool.getPendingRPLRewards();
    console.log(`ok ${tx.hash}`);
    console.log(`After:   pool=${ethers.formatEther(afterPool)} pending=${ethers.formatEther(afterPending)}`);
    if (afterPending === 0n) {
        throw new Error('pending RPL still 0 after deposit');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
