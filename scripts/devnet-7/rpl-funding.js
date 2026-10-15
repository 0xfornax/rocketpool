const { ethers } = require('ethers');

const RPL_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
    'function transfer(address,uint256) returns (bool)',
    'function swapTokens(uint256)',
];
const DRPL_ABI = [...RPL_ABI, 'function mint(address,uint256)'];

// Simulate the deployment's funding order, including overlapping recipients.
// Keep seed funding additive; bonds/rewards/staking only require their deficits.
function planRplFunding({ guardian, balances, members = [], bond = 0n,
    seedAddress, seedAmount = 0n, rewardsAmount = 0n, operator, stakeAmount = 0n }) {
    guardian = guardian.toLowerCase();
    const ledger = new Map(Object.entries(balances).map(([a, v]) => [a.toLowerCase(), v]));
    const balance = a => ledger.get(a.toLowerCase()) || 0n;
    const initial = balance(guardian);
    let minimum = initial;
    function change(a, delta) {
        a = a.toLowerCase();
        ledger.set(a, balance(a) + delta);
        minimum = balance(guardian) < minimum ? balance(guardian) : minimum;
    }
    function transfer(a, amount) {
        if (a.toLowerCase() === guardian || amount <= 0n) return;
        change(guardian, -amount);
        change(a, amount);
    }
    for (const member of new Set(members.map(a => a.toLowerCase()))) {
        transfer(member, bond - balance(member));
        change(member, -bond);
    }
    if (seedAmount > 0n) transfer(seedAddress, seedAmount);
    change(guardian, -rewardsAmount);
    if (stakeAmount > 0n) {
        transfer(operator, stakeAmount - balance(operator));
        change(operator, -stakeAmount);
    }
    const swapAmount = minimum < 0n ? -minimum : 0n;
    return { swapAmount, requiredGuardianBalance: initial + swapAmount };
}

async function send(contract, method, args) {
    const floor = BigInt(process.env.TX_GAS_MIN || '3000000');
    const cap = BigInt(process.env.TX_GAS_CAP || '16000000');
    const estimate = await contract[method].estimateGas(...args);
    if (floor <= 0n || cap < floor || estimate > cap) throw new Error(`Invalid gas limits for ${method}`);
    const buffered = estimate * 150n / 100n;
    const limit = buffered > floor ? buffered : floor;
    const tx = await contract[method](...args, { gasLimit: limit > cap ? cap : limit });
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error(`${method} failed: ${tx.hash}`);
    console.log(`    ${method}: ${tx.hash}`);
}

// Standalone helpers can still swap a deficit; deploy.sh reserves the whole
// deployment requirement first, so subsequent calls only read the RPL balance.
async function ensureGuardianRpl({ guardian, rpl, dummyRpl, amount }) {
    if (amount < 0n) throw new Error('RPL funding amount must be nonnegative');
    const current = await rpl.balanceOf(guardian.address);
    if (current >= amount) return;
    if (process.env.RPL_FUNDING_PREPARED === '1') {
        throw new Error(`Prepared guardian RPL balance is insufficient: ${current} < ${amount}`);
    }
    const deficit = amount - current;
    const dummyBalance = await dummyRpl.balanceOf(guardian.address);
    if (dummyBalance < deficit) {
        await send(dummyRpl, 'mint', [guardian.address, deficit - dummyBalance]);
    }
    const spender = await rpl.getAddress();
    if (await dummyRpl.allowance(guardian.address, spender) < deficit) {
        await send(dummyRpl, 'approve', [spender, deficit]);
    }
    console.log(`  Swapping ${ethers.formatEther(deficit)} DRPL → RPL in guardian wallet`);
    await send(rpl, 'swapTokens', [deficit]);
    if (await rpl.balanceOf(guardian.address) < amount) throw new Error('RPL swap did not supply the required balance');
}

module.exports = { planRplFunding, ensureGuardianRpl, RPL_ABI, DRPL_ABI };
