/**
 * Seed a Kurtosis Rocket Pool deploy with operator funds and deposit-pool ETH.
 *
 * Run after contracts are deployed and deposits are enabled.
 * Use --deposit-pool-only for early pool funding; DEPOSIT_POOL_ETH=0 skips it
 * during the subsequent operator/settings seed.
 *
 * Default actions:
 *   1. Deposit DEPOSIT_POOL_ETH (default 500) into RocketDepositPool
 *   2. Send SEED_ETH (default 100) to SEED_ADDRESS
 *   3. Transfer SEED_RPL (default 10000) to SEED_ADDRESS from guardian RPL
 *      (deploy.sh swaps once up front; standalone runs swap only a deficit)
 *   4. Deposit REWARDS_POOL_RPL (default 1000) into RocketVault for rocketRewardsPool
 *      so watchtower can submit a rewards tree before the first 1-day RPL inflation mint
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
const { ensureGuardianRpl } = require('./rpl-funding');

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
// RPL assigned to rocketRewardsPool in the vault. Pending rewards =
// vault balance for the pool + unminted inflation. Inflation interval is a
// hardcoded 1 day on RocketTokenRPL, so short claim intervals (e.g. 20 min)
// need a seeded vault balance or tree gen fails with "no pending RPL rewards".
const DEFAULT_REWARDS_POOL_RPL = '1000';

const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
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
    'function bootstrapEnableGovernance()',
];
const DEPOSIT_SETTINGS_ABI = [
    'function getMaximumDepositPoolSize() view returns (uint256)',
    'function getDepositEnabled() view returns (bool)',
];
const VAULT_ABI = [
    'function balanceOfToken(string networkContractName, address tokenAddress) view returns (uint256)',
    'function depositToken(string networkContractName, address tokenAddress, uint256 amount)',
];
const REWARDS_POOL_ABI = [
    'function getPendingRPLRewards() view returns (uint256)',
    'function getRPLBalance() view returns (uint256)',
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
    const rewardsPoolRpl = ethers.parseEther(process.env.REWARDS_POOL_RPL || DEFAULT_REWARDS_POOL_RPL);

    const deployment = loadDeployment();
    const provider = new ethers.JsonRpcProvider(providerUrl);
    const guardian = new ethers.Wallet(guardianKey, provider);
    const ethSource = new ethers.Wallet(ethSourceKey, provider);

    const dummyRpl = new ethers.Contract(addr(deployment, 'RocketTokenDummyRPL'), DUMMY_RPL_ABI, guardian);
    const rpl = new ethers.Contract(addr(deployment, 'RocketTokenRPL'), RPL_ABI, guardian);
    const depositPool = new ethers.Contract(addr(deployment, 'RocketDepositPool'), DEPOSIT_POOL_ABI, guardian);
    const daoProtocol = new ethers.Contract(addr(deployment, 'RocketDAOProtocol'), DAO_PROTOCOL_ABI, guardian);
    const vault = new ethers.Contract(addr(deployment, 'RocketVault'), VAULT_ABI, guardian);
    const rewardsPool = new ethers.Contract(addr(deployment, 'RocketRewardsPool'), REWARDS_POOL_ABI, provider);
    const depositSettings = new ethers.Contract(
        addr(deployment, 'RocketDAOProtocolSettingsDeposit'),
        DEPOSIT_SETTINGS_ABI,
        provider,
    );

    // Fund the pool before operator funding or any optional devnet setup.
    if (depositPoolEth > 0n) {
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
        // Full deposit path (mint rETH + vault + optional assign) costs ~1.5–2.5M gas.
        // Some geth builds under-estimate; a ~281k limit OOGs with a bare CALL_EXCEPTION.
        const gasFloor = BigInt(process.env.DEPOSIT_GAS_LIMIT || '5000000');
        let gasLimit = gasFloor;
        try {
            const estimated = await depositPool.deposit.estimateGas({ value: depositPoolEth });
            const buffered = (estimated * 150n) / 100n;
            if (buffered > gasLimit) gasLimit = buffered;
            console.log(`  - Depositing ${ethers.formatEther(depositPoolEth)} ETH into RocketDepositPool...`);
            console.log(`    estimateGas=${estimated} gasLimit=${gasLimit}`);
        } catch (e) {
            console.log(`  - Depositing ${ethers.formatEther(depositPoolEth)} ETH into RocketDepositPool...`);
            console.log(`    (estimateGas failed: ${e.shortMessage || e.message}; using gasLimit=${gasLimit})`);
            // Preflight for a useful revert string when estimate fails
            try {
                await depositPool.deposit.staticCall({ value: depositPoolEth });
            } catch (e2) {
                throw new Error(
                    `deposit() would revert: ${e2.reason || e2.shortMessage || e2.message}`,
                );
            }
        }
        const tx = await depositPool.deposit({ value: depositPoolEth, gasLimit });
        const rc = await tx.wait();
        if (rc.status !== 1) {
            throw new Error(`deposit() failed status=${rc.status} gasUsed=${rc.gasUsed} (likely OOG if gasUsed≈gasLimit)`);
        }
        console.log(`    ok ${tx.hash} gasUsed=${rc.gasUsed}`);
        const after = await depositPool.getBalance();
        console.log(`    pool balance now ${ethers.formatEther(after)} ETH`);
    }


    if (process.argv.includes('--deposit-pool-only')) {
        console.log('Deposit-pool seed complete');
        provider.destroy();
        return;
    }

    // Min allowed by RocketDAOProtocolSettingsMegapool.setSettingUint guardrail.
    // Mainnet default is 112; with short kurtosis exit timelines withdrawable_epoch
    // is often < 112, and notifyExit does:
    //   if (recentEpoch > withdrawableEpoch - notifyThreshold) { fine }
    // which underflows (silent panic) when withdrawableEpoch < threshold.
    // DevnetPostSaturn uses 19 for the same reason.
    const notifyThreshold = BigInt(process.env.NOTIFY_THRESHOLD || '19');
    // oDAO prices/balances submit interval (seconds). Mainnet default is 1 day;
    // 300s keeps watchtower useful on short-lived Kurtosis chains.
    // Requires Kurtosis SettingsNetwork guardrail patch (prepare-master-worktree)
    // because stock contracts enforce balances.frequency >= 1 hour.
    const submitFrequency = BigInt(process.env.SUBMIT_FREQUENCY_SECS || '300');
    // Rewards claim interval = periods × balances.frequency.
    // Default periods=4 → 4×300s = 20 minutes (mainnet is 28×1 day).
    // Path is the packed storage key suffix used by SettingsRewards / pDAO:
    //   encodePacked("rewards.claims", "periods") → "rewards.claimsperiods"
    const rewardsClaimPeriods = BigInt(process.env.REWARDS_CLAIM_PERIODS || '4');
    // pDAO vote windows. Mainnet is 1 week each (guardrail >= 1 day). Kurtosis
    // SettingsProposals patch lowers that to 15 minutes.
    const proposalVotePhaseTime = BigInt(process.env.PROPOSAL_VOTE_PHASE_SECS || '900');
    const proposalVoteDelayTime = BigInt(process.env.PROPOSAL_VOTE_DELAY_SECS || '300');
    // Security-council veto window after an oDAO upgrade proposal is executed.
    // Mainnet is 7 days (guardrail >= 1 day). Kurtosis SettingsSecurity patch
    // lowers that to 10 minutes so execute-upgrade is usable on a short chain.
    const upgradeDelayTime = BigInt(process.env.UPGRADE_DELAY_SECS || '600');

    console.log('Seed Kurtosis devnet');
    console.log(`  RPC:            ${providerUrl}`);
    console.log(`  Guardian:       ${guardian.address}`);
    console.log(`  ETH source:     ${ethSource.address}`);
    console.log(`  Seed address:   ${seedAddress}`);
    console.log(`  Seed ETH:       ${ethers.formatEther(seedEth)}`);
    console.log(`  Seed RPL:       ${ethers.formatEther(seedRpl)}`);
    console.log(`  Rewards pool RPL: ${ethers.formatEther(rewardsPoolRpl)} (vault → rocketRewardsPool)`);
    console.log(`  Deposit pool:   ${ethers.formatEther(depositPoolEth)} ETH`);
    console.log(`  notify.threshold: ${notifyThreshold}`);
    console.log(`  submit frequency: ${submitFrequency}s (balances + prices)`);
    console.log(`  rewards periods:  ${rewardsClaimPeriods} (interval ${rewardsClaimPeriods * submitFrequency}s)`);
    console.log(`  proposal phases:  ${proposalVotePhaseTime}s (phase1 + phase2)`);
    console.log(`  proposal delay:   ${proposalVoteDelayTime}s`);
    console.log(`  upgrade delay:    ${upgradeDelayTime}s`);

    // --- 0a) Enable on-chain pDAO proposals (bootstrapEnableGovernance) ---
    // Without this, createProposal reverts with "DAO has not been enabled".
    // Leaves bootstrap mode open so further guardian bootstraps still work.
    {
        const storage = new ethers.Contract(addr(deployment, 'RocketStorage'), [
            'function getUint(bytes32) view returns (uint256)',
        ], provider);
        const enabledKey = ethers.keccak256(ethers.toUtf8Bytes('protocol.dao.enabled.block'));
        const enabledBlock = await storage.getUint(enabledKey);
        if (enabledBlock > 0n) {
            console.log(`  - pDAO governance already enabled at block ${enabledBlock}`);
        } else {
            const bootstrapDisabled = await daoProtocol.getBootstrapModeDisabled();
            if (bootstrapDisabled) {
                throw new Error('pDAO governance is disabled and bootstrap mode is closed');
            }
            console.log('  - Enabling pDAO on-chain governance (bootstrapEnableGovernance)...');
            const tx = await daoProtocol.bootstrapEnableGovernance();
            await tx.wait();
            const after = await storage.getUint(enabledKey);
            if (after === 0n) {
                throw new Error('protocol.dao.enabled.block still 0 after bootstrapEnableGovernance');
            }
            console.log(`    ok ${tx.hash} (enabled at block ${after})`);
        }
    }

    // --- 0b) Megapool notify.threshold (must be low enough for young chains) ---
    {
        const settingsAddr = addr(deployment, 'RocketDAOProtocolSettingsMegapool');
        const settings = new ethers.Contract(settingsAddr, [
            'function getNotifyThreshold() view returns (uint256)',
        ], provider);
        const current = await settings.getNotifyThreshold();
        if (current === notifyThreshold) {
            console.log(`  - notify.threshold already ${current}`);
        } else {
            const bootstrapDisabled = await daoProtocol.getBootstrapModeDisabled();
            if (bootstrapDisabled) {
                throw new Error(
                    `notify.threshold is ${current} (want ${notifyThreshold}) but bootstrap mode is closed`,
                );
            }
            console.log(`  - Setting notify.threshold ${current} → ${notifyThreshold}...`);
            const tx = await daoProtocol.bootstrapSettingUint(
                'rocketDAOProtocolSettingsMegapool',
                'notify.threshold',
                notifyThreshold,
            );
            await tx.wait();
            const after = await settings.getNotifyThreshold();
            if (after !== notifyThreshold) {
                throw new Error(`notify.threshold still ${after} after bootstrap`);
            }
            console.log(`    ok ${tx.hash}`);
        }
    }

    // --- 0c) oDAO prices/balances submit frequency (default 300s for Kurtosis) ---
    {
        const settingsAddr = addr(deployment, 'RocketDAOProtocolSettingsNetwork');
        const settings = new ethers.Contract(settingsAddr, [
            'function getSubmitBalancesFrequency() view returns (uint256)',
            'function getSubmitPricesFrequency() view returns (uint256)',
        ], provider);
        const paths = [
            {
                path: 'network.submit.balances.frequency',
                getter: () => settings.getSubmitBalancesFrequency(),
                label: 'balances',
            },
            {
                path: 'network.submit.prices.frequency',
                getter: () => settings.getSubmitPricesFrequency(),
                label: 'prices',
            },
        ];
        for (const { path: settingPath, getter, label } of paths) {
            const current = await getter();
            if (current === submitFrequency) {
                console.log(`  - ${settingPath} already ${current}s`);
                continue;
            }
            const bootstrapDisabled = await daoProtocol.getBootstrapModeDisabled();
            if (bootstrapDisabled) {
                throw new Error(
                    `${settingPath} is ${current}s (want ${submitFrequency}s) but bootstrap mode is closed`,
                );
            }
            console.log(`  - Setting ${settingPath} ${current}s → ${submitFrequency}s...`);
            try {
                const tx = await daoProtocol.bootstrapSettingUint(
                    'rocketDAOProtocolSettingsNetwork',
                    settingPath,
                    submitFrequency,
                );
                await tx.wait();
            } catch (e) {
                const msg = e.shortMessage || e.message || String(e);
                throw new Error(
                    `Failed to set ${settingPath} to ${submitFrequency}s: ${msg}\n`
                    + `  Stock SettingsNetwork requires balances.frequency >= 1 hour.\n`
                    + `  Kurtosis baseline deploy patches that guardrail via prepare-master-worktree.sh;\n`
                    + `  re-run a CLEAN deploy so the patched SettingsNetwork is on-chain, or set\n`
                    + `  SUBMIT_FREQUENCY_SECS=3600 for the stock minimum.`,
                );
            }
            const after = await getter();
            if (after !== submitFrequency) {
                throw new Error(`${settingPath} still ${after}s after bootstrap`);
            }
            console.log(`    ok (${label})`);
        }
    }

    // --- 0d) Rewards claim interval periods (× balances frequency = wall-clock interval) ---
    {
        const settingsAddr = addr(deployment, 'RocketDAOProtocolSettingsRewards');
        const settings = new ethers.Contract(settingsAddr, [
            'function getRewardsClaimIntervalPeriods() view returns (uint256)',
            'function getRewardsClaimIntervalTime() view returns (uint256)',
        ], provider);
        const current = await settings.getRewardsClaimIntervalPeriods();
        if (current === rewardsClaimPeriods) {
            const t = await settings.getRewardsClaimIntervalTime();
            console.log(`  - rewards.claimsperiods already ${current} (interval ${t}s)`);
        } else {
            const bootstrapDisabled = await daoProtocol.getBootstrapModeDisabled();
            if (bootstrapDisabled) {
                throw new Error(
                    `rewards.claimsperiods is ${current} (want ${rewardsClaimPeriods}) but bootstrap mode is closed`,
                );
            }
            console.log(`  - Setting rewards.claimsperiods ${current} → ${rewardsClaimPeriods}...`);
            const tx = await daoProtocol.bootstrapSettingUint(
                'rocketDAOProtocolSettingsRewards',
                'rewards.claimsperiods',
                rewardsClaimPeriods,
            );
            await tx.wait();
            const after = await settings.getRewardsClaimIntervalPeriods();
            if (after !== rewardsClaimPeriods) {
                throw new Error(`rewards.claimsperiods still ${after} after bootstrap`);
            }
            const intervalTime = await settings.getRewardsClaimIntervalTime();
            console.log(`    ok ${tx.hash} (claim interval ${intervalTime}s)`);
        }
    }

    // --- 0d2) pDAO vote phase 1 / phase 2 windows ---
    {
        const settingsAddr = addr(deployment, 'RocketDAOProtocolSettingsProposals');
        const settings = new ethers.Contract(settingsAddr, [
            'function getVotePhase1Time() view returns (uint256)',
            'function getVotePhase2Time() view returns (uint256)',
            'function getVoteDelayTime() view returns (uint256)',
        ], provider);
        const paths = [
            { path: 'proposal.vote.phase1.time', getter: () => settings.getVotePhase1Time(), want: proposalVotePhaseTime, label: 'phase1', hint: 'vote phase time >= 1 day' },
            { path: 'proposal.vote.phase2.time', getter: () => settings.getVotePhase2Time(), want: proposalVotePhaseTime, label: 'phase2', hint: 'vote phase time >= 1 day' },
            { path: 'proposal.vote.delay.time', getter: () => settings.getVoteDelayTime(), want: proposalVoteDelayTime, label: 'delay', hint: 'vote delay >= 1 week' },
        ];
        for (const { path: settingPath, getter, want, label, hint } of paths) {
            const current = await getter();
            if (current === want) {
                console.log(`  - ${settingPath} already ${current}s`);
                continue;
            }
            const bootstrapDisabled = await daoProtocol.getBootstrapModeDisabled();
            if (bootstrapDisabled) {
                throw new Error(
                    `${settingPath} is ${current}s (want ${want}s) but bootstrap mode is closed`,
                );
            }
            console.log(`  - Setting ${settingPath} ${current}s → ${want}s...`);
            try {
                const tx = await daoProtocol.bootstrapSettingUint(
                    'rocketDAOProtocolSettingsProposals',
                    settingPath,
                    want,
                );
                await tx.wait();
            } catch (e) {
                const msg = e.shortMessage || e.message || String(e);
                throw new Error(
                    `Failed to set ${settingPath} to ${want}s: ${msg}\n`
                    + `  Stock SettingsProposals requires ${hint}.\n`
                    + `  Kurtosis baseline deploy patches that guardrail via prepare-master-worktree.sh.`,
                );
            }
            const after = await getter();
            if (after !== want) {
                throw new Error(`${settingPath} still ${after}s after bootstrap`);
            }
            console.log(`    ok (${label})`);
        }
    }

    // --- 0d3) oDAO upgrade execute delay (security-council veto window) ---
    {
        const settingsAddr = addr(deployment, 'RocketDAOProtocolSettingsSecurity');
        const settings = new ethers.Contract(settingsAddr, [
            'function getUpgradeDelay() view returns (uint256)',
        ], provider);
        const current = await settings.getUpgradeDelay();
        if (current === upgradeDelayTime) {
            console.log(`  - upgrade.delay already ${current}s`);
        } else {
            const bootstrapDisabled = await daoProtocol.getBootstrapModeDisabled();
            if (bootstrapDisabled) {
                throw new Error(
                    `upgrade.delay is ${current}s (want ${upgradeDelayTime}s) but bootstrap mode is closed`,
                );
            }
            console.log(`  - Setting upgrade.delay ${current}s → ${upgradeDelayTime}s...`);
            try {
                const tx = await daoProtocol.bootstrapSettingUint(
                    'rocketDAOProtocolSettingsSecurity',
                    'upgrade.delay',
                    upgradeDelayTime,
                );
                await tx.wait();
            } catch (e) {
                const msg = e.shortMessage || e.message || String(e);
                console.log(`    bootstrapSettingUint failed (${msg}); falling back to storage write`);
                const helper = path.join(__dirname, 'set-upgrade-delay.js');
                const result = require('child_process').spawnSync(
                    process.execPath,
                    [helper],
                    {
                        cwd: ROOT,
                        env: {
                            ...process.env,
                            PROVIDER_URL: providerUrl,
                            UPGRADE_DELAY_SECS: upgradeDelayTime.toString(),
                        },
                        stdio: 'inherit',
                    },
                );
                if (result.status !== 0) {
                    throw new Error(
                        `Failed to set upgrade.delay to ${upgradeDelayTime}s: ${msg}\n`
                        + `  Stock SettingsSecurity requires upgrade.delay >= 1 day.\n`
                        + `  Kurtosis baseline deploy patches that guardrail via prepare-master-worktree.sh.`,
                    );
                }
            }
            const after = await settings.getUpgradeDelay();
            if (after !== upgradeDelayTime) {
                throw new Error(`upgrade.delay still ${after}s after set`);
            }
            console.log(`    ok (upgrade delay ${after}s)`);
        }
    }

    // --- 0e) RPL inflation start (must be near "now" for rewards trees on Kurtosis) ---
    // Watchtower treats rewards.pool.claim.interval.time.start == 0 as "use RPL
    // inflation start". Deploy defaults set inflation to host-now + 14 days, so
    // intervalsPassed stays 0 and submit-rewards exits silently until then.
    // Guardrail: start must be > block.timestamp and not already started.
    {
        const settingsAddr = addr(deployment, 'RocketDAOProtocolSettingsInflation');
        const settings = new ethers.Contract(settingsAddr, [
            'function getInflationIntervalStartTime() view returns (uint256)',
        ], provider);
        const current = await settings.getInflationIntervalStartTime();
        const latest = await provider.getBlock('latest');
        const now = BigInt(latest.timestamp);
        // Delay a few slots so the set tx itself is still "in the future".
        const delay = BigInt(process.env.INFLATION_START_DELAY_SECS || '60');
        const target = now + delay;
        if (current > 0n && current <= now) {
            console.log(`  - rpl.inflation.interval.start already started at ${current} (chain now ${now})`);
        } else if (current > now && current <= now + 300n) {
            console.log(`  - rpl.inflation.interval.start already soon (${current - now}s)`);
        } else {
            const bootstrapDisabled = await daoProtocol.getBootstrapModeDisabled();
            if (bootstrapDisabled) {
                throw new Error(
                    `rpl.inflation.interval.start is ${current} (want ~${target}) but bootstrap mode is closed`,
                );
            }
            console.log(`  - Setting rpl.inflation.interval.start ${current} → ${target} (now+${delay}s)...`);
            const tx = await daoProtocol.bootstrapSettingUint(
                'rocketDAOProtocolSettingsInflation',
                'rpl.inflation.interval.start',
                target,
            );
            await tx.wait();
            const after = await settings.getInflationIntervalStartTime();
            console.log(`    ok ${tx.hash} (start ${after})`);
            console.log(
                `    NOTE: first rewards interval ends ~${rewardsClaimPeriods * submitFrequency}s after start; `
                + `RPL inflation mint interval is still 1 day (token constant) — `
                + `seed funds rocketRewardsPool so pending RPL is non-zero before then.`,
            );
        }
    }

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

    // --- 2) RPL to seed address + rewards pool from the guardian reserve ---
    {
        const currentRewards = await vault.balanceOfToken('rocketRewardsPool', await rpl.getAddress());
        const rewardsDeficit = rewardsPoolRpl > currentRewards ? rewardsPoolRpl - currentRewards : 0n;
        const seedTransfer = seedAddress.toLowerCase() === guardian.address.toLowerCase() ? 0n : seedRpl;
        await ensureGuardianRpl({ guardian, rpl, dummyRpl, amount: seedTransfer + rewardsDeficit });
        let tx;
        if (seedTransfer > 0n) {
            console.log(`  - Transfer ${ethers.formatEther(seedTransfer)} RPL to ${seedAddress}...`);
            tx = await rpl.transfer(seedAddress, seedTransfer);
            await tx.wait();
            console.log(`    ok ${tx.hash}`);
        }

        // Fund rocketRewardsPool so getPendingRPLRewards() > 0 before the first
        // 1-day inflation interval elapses (required for Merkle tree generation).
        if (rewardsPoolRpl > 0n) {
            const rplAddr = await rpl.getAddress();
            const currentPool = await vault.balanceOfToken('rocketRewardsPool', rplAddr);
            if (currentPool >= rewardsPoolRpl) {
                console.log(
                    `  - rocketRewardsPool already has ${ethers.formatEther(currentPool)} RPL in vault `
                    + `(want ≥ ${ethers.formatEther(rewardsPoolRpl)}); skip deposit`,
                );
            } else {
                const toDeposit = rewardsPoolRpl - currentPool;
                console.log(
                    `  - Deposit ${ethers.formatEther(toDeposit)} RPL into vault for rocketRewardsPool...`,
                );
                tx = await rpl.approve(await vault.getAddress(), toDeposit);
                await tx.wait();
                tx = await vault.depositToken('rocketRewardsPool', rplAddr, toDeposit);
                await tx.wait();
                const pending = await rewardsPool.getPendingRPLRewards();
                const poolBal = await rewardsPool.getRPLBalance();
                console.log(
                    `    ok ${tx.hash} (pool RPL ${ethers.formatEther(poolBal)}, `
                    + `pending ${ethers.formatEther(pending)})`,
                );
            }
        }
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
