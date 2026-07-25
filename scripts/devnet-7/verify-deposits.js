/**
 * Post-deploy check: protocol + node deposit flags must be enabled.
 *
 * Usage:
 *   PROVIDER_URL=http://127.0.0.1:8545 node scripts/devnet-7/verify-deposits.js
 *   node scripts/devnet-7/verify-deposits.js --rpc http://127.0.0.1:8545
 *
 * Reads addresses from deployments/latest.json (or DEPLOYMENT_FILE).
 */
const path = require('path');
const { ethers } = require('ethers');

const root = path.resolve(__dirname, '../..');
const deploymentFile = process.env.DEPLOYMENT_FILE
    || path.join(root, 'deployments', 'latest.json');

function parseArgs(argv) {
    let rpc = process.env.PROVIDER_URL || '';
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--rpc' && argv[i + 1]) {
            rpc = argv[++i];
        }
    }
    return { rpc };
}

async function main() {
    const { rpc } = parseArgs(process.argv);
    if (!rpc) {
        throw new Error('PROVIDER_URL or --rpc is required');
    }

    const d = require(deploymentFile);
    const depositAddr = d.addresses && d.addresses.RocketDAOProtocolSettingsDeposit;
    const nodeAddr = d.addresses && d.addresses.RocketDAOProtocolSettingsNode;
    if (!depositAddr || !nodeAddr) {
        throw new Error(
            'deployment missing RocketDAOProtocolSettingsDeposit / RocketDAOProtocolSettingsNode',
        );
    }

    const provider = new ethers.JsonRpcProvider(rpc);
    const deposit = new ethers.Contract(depositAddr, [
        'function getDepositEnabled() view returns (bool)',
        'function getAssignDepositsEnabled() view returns (bool)',
        'function getMaximumDepositPoolSize() view returns (uint256)',
    ], provider);
    const node = new ethers.Contract(nodeAddr, [
        'function getRegistrationEnabled() view returns (bool)',
        'function getDepositEnabled() view returns (bool)',
    ], provider);

    const [
        depositEnabled,
        assignEnabled,
        maxPool,
        nodeRegEnabled,
        nodeDepositEnabled,
    ] = await Promise.all([
        deposit.getDepositEnabled(),
        deposit.getAssignDepositsEnabled(),
        deposit.getMaximumDepositPoolSize(),
        node.getRegistrationEnabled(),
        node.getDepositEnabled(),
    ]);

    console.log(`  deposit.enabled              = ${depositEnabled}`);
    console.log(`  deposit.assign.enabled       = ${assignEnabled}`);
    console.log(`  deposit.pool.maximum         = ${ethers.formatEther(maxPool)} ETH`);
    console.log(`  node.registration.enabled    = ${nodeRegEnabled}`);
    console.log(`  node.deposit.enabled         = ${nodeDepositEnabled}`);

    const failures = [];
    if (!depositEnabled) failures.push('deposit.enabled is false');
    if (!assignEnabled) failures.push('deposit.assign.enabled is false');
    if (!nodeRegEnabled) failures.push('node.registration.enabled is false');
    if (!nodeDepositEnabled) failures.push('node.deposit.enabled is false');

    if (failures.length) {
        console.error('Deposit verification FAILED:');
        for (const f of failures) console.error(`  - ${f}`);
        process.exit(1);
    }
    console.log('  Deposits verification OK');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
