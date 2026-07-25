/**
 * Verify oDAO membership on-chain after bootstrap.
 *
 * Usage:
 *   PROVIDER_URL=http://127.0.0.1:PORT node scripts/devnet-7/verify-odao.js
 *   node scripts/devnet-7/verify-odao.js --rpc http://127.0.0.1:PORT
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '../..');
const DEPLOYMENT_FILE = process.env.DEPLOYMENT_FILE
    || path.join(ROOT, 'deployments', 'latest.json');
const ODAO_FILE = process.env.ODAO_OUTPUT
    || path.join(ROOT, 'deployments', 'odao-local.json');

function parseArgs(argv) {
    let rpc = process.env.PROVIDER_URL || '';
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--rpc' && argv[i + 1]) rpc = argv[++i];
    }
    return { rpc };
}

async function main() {
    const { rpc } = parseArgs(process.argv);
    if (!rpc) throw new Error('PROVIDER_URL or --rpc is required');
    if (!fs.existsSync(ODAO_FILE)) {
        throw new Error(`Missing ${ODAO_FILE}; run bootstrap-odao.js first`);
    }
    if (!fs.existsSync(DEPLOYMENT_FILE)) {
        throw new Error(`Missing ${DEPLOYMENT_FILE}`);
    }

    const odao = JSON.parse(fs.readFileSync(ODAO_FILE, 'utf8'));
    const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8'));
    const member = odao.member && odao.member.address;
    if (!member) throw new Error('odao-local.json missing member.address');

    const daoAddr = (deployment.addresses && deployment.addresses.RocketDAONodeTrusted)
        || (odao.contracts && odao.contracts.RocketDAONodeTrusted);
    if (!daoAddr) throw new Error('RocketDAONodeTrusted address not found');

    const provider = new ethers.JsonRpcProvider(rpc);
    const dao = new ethers.Contract(daoAddr, [
        'function getMemberIsValid(address) view returns (bool)',
        'function getMemberCount() view returns (uint256)',
        'function getMemberID(address) view returns (string)',
        'function getMemberRPLBondAmount(address) view returns (uint256)',
    ], provider);

    const [valid, count, id, bond] = await Promise.all([
        dao.getMemberIsValid(member),
        dao.getMemberCount(),
        dao.getMemberID(member),
        dao.getMemberRPLBondAmount(member),
    ]);

    console.log(`  member                 = ${member}`);
    console.log(`  getMemberIsValid       = ${valid}`);
    console.log(`  getMemberID            = ${id}`);
    console.log(`  getMemberRPLBondAmount = ${ethers.formatEther(bond)} RPL`);
    console.log(`  getMemberCount         = ${count}`);

    if (!valid) {
        console.error('oDAO verification FAILED: member is not valid');
        process.exit(1);
    }
    if (count < 1n) {
        console.error('oDAO verification FAILED: member count is 0');
        process.exit(1);
    }
    console.log('  oDAO verification OK');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
