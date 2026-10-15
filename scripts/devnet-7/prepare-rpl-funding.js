/** Reserve all RPL needed by deploy.sh with one guardian DRPL approval/swap. */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { loadSmartNodeWallet, resolveMemberKey } = require('./bootstrap-odao');
const { planRplFunding, ensureGuardianRpl, RPL_ABI, DRPL_ABI } = require('./rpl-funding');

const DEFAULT_GUARDIAN_KEY = '0xbcdf20249abf0ed6d944c0288fad489e33f66b3960d9e6229c1cd214ed3bbe31';
const DEFAULT_THIRD_MEMBER_KEY = '0x39725efee3fb28614de3bacaffe4cc4bd8c436257e2c8bb887c4b5c4be45e76d';
const wallet = key => new ethers.Wallet(key.startsWith('0x') ? key : `0x${key}`);
const amount = (name, fallback) => {
    const value = ethers.parseEther(process.env[name] || fallback);
    if (value < 0n) throw new Error(`${name} must be nonnegative`);
    return value;
};

async function main() {
    const deploymentFile = process.env.DEPLOYMENT_FILE || path.resolve(__dirname, '../../deployments/latest.json');
    const { addresses } = JSON.parse(fs.readFileSync(deploymentFile, 'utf8'));
    if (!process.env.PROVIDER_URL) throw new Error('PROVIDER_URL is required');
    const provider = new ethers.JsonRpcProvider(process.env.PROVIDER_URL);
    try {
        const guardian = wallet(process.env.PRIVATE_KEY || DEFAULT_GUARDIAN_KEY).connect(provider);
        const contract = (name, abi) => {
            if (!addresses[name]) throw new Error(`Missing ${name} in deployment`);
            return new ethers.Contract(addresses[name], abi, guardian);
        };
        const rpl = contract('RocketTokenRPL', RPL_ABI);
        const dummyRpl = contract('RocketTokenDummyRPL', DRPL_ABI);
        const members = [];
        let bond = 0n;
        if (process.env.SKIP_ODAO !== '1') {
            const dao = contract('RocketDAONodeTrusted', [
                'function getMemberIsValid(address) view returns (bool)',
                'function getMemberCount() view returns (uint256)',
                'function getMemberMinRequired() view returns (uint256)',
            ]);
            const settings = contract('RocketDAONodeTrustedSettingsMembers', ['function getRPLBond() view returns (uint256)']);
            bond = await settings.getRPLBond();
            async function includeMember(address) {
                if (!members.some(a => a.toLowerCase() === address.toLowerCase()) && !await dao.getMemberIsValid(address)) {
                    members.push(address);
                }
            }
            await includeMember(wallet(resolveMemberKey()).address);
            const rp4 = process.env.RP4_DIR || '/srv/rocketpool4';
            if (process.env.SKIP_ODAO_RP4 !== '1' && fs.existsSync(path.join(rp4, 'data/wallet'))) {
                await includeMember(loadSmartNodeWallet(rp4).address);
            }
            if (process.env.SKIP_ODAO_UPGRADE_PROPOSAL !== '1' && process.env.SKIP_THIRD_MEMBER !== '1') {
                const projectedCount = await dao.getMemberCount() + BigInt(members.length);
                if (projectedCount < await dao.getMemberMinRequired()) {
                    await includeMember(wallet(process.env.ODAO_THIRD_MEMBER_KEY || DEFAULT_THIRD_MEMBER_KEY).address);
                }
            }
        }
        const seedAddress = process.env.SEED_ADDRESS || '0xc7EBC35C761bFbaE449973E226CE3295B9B7f996';
        let seedAmount = 0n;
        let rewardsAmount = 0n;
        if (process.env.SKIP_SEED !== '1') {
            seedAmount = amount('SEED_RPL', '10000');
            const target = amount('REWARDS_POOL_RPL', '1000');
            const vault = contract('RocketVault', ['function balanceOfToken(string,address) view returns (uint256)']);
            const current = await vault.balanceOfToken('rocketRewardsPool', addresses.RocketTokenRPL);
            rewardsAmount = target > current ? target - current : 0n;
        }
        let operator;
        let stakeAmount = 0n;
        const rpDir = process.env.RP_DIR || '/srv/rocketpool3';
        if (process.env.SKIP_REGISTER !== '1' && fs.existsSync(path.join(rpDir, 'data/wallet'))) {
            operator = process.env.OPERATOR_PRIVATE_KEY
                ? wallet(process.env.OPERATOR_PRIVATE_KEY).address : loadSmartNodeWallet(rpDir).address;
            const staking = contract('RocketNodeStaking', ['function getNodeStakedRPL(address) view returns (uint256)']);
            const target = amount('STAKE_RPL', '2000');
            const current = await staking.getNodeStakedRPL(operator);
            stakeAmount = target > current ? target - current : 0n;
        }
        const recipients = new Set([guardian.address, ...members, seedAddress, operator].filter(Boolean));
        const balances = Object.fromEntries(await Promise.all([...recipients].map(async a => [a, await rpl.balanceOf(a)])));
        const plan = planRplFunding({ guardian: guardian.address, balances, members, bond,
            seedAddress, seedAmount, rewardsAmount, operator, stakeAmount });
        console.log(`Combined RPL funding: ${members.length} new oDAO bonds, ${ethers.formatEther(seedAmount)} operator seed, ${ethers.formatEther(rewardsAmount)} rewards`);
        console.log(`  Guardian balance: ${ethers.formatEther(balances[guardian.address])}; swap deficit: ${ethers.formatEther(plan.swapAmount)} RPL`);
        await ensureGuardianRpl({ guardian, rpl, dummyRpl, amount: plan.requiredGuardianBalance });
    } finally {
        provider.destroy();
    }
}

if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
