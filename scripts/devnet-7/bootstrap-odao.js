/**
 * Bootstrap a single oDAO (Oracle DAO / trusted node) member on a Kurtosis deploy.
 *
 * Prerequisites:
 *   - Rocket Pool contracts deployed (deployments/latest.json)
 *   - Guardian = ethereum-package prefunded account #0 (deployer / CHAIN=kurtosis guardian)
 *   - Member  = ethereum-package prefunded account #1 (default)
 *
 * Flow:
 *   1. Fund member with DRPL → swap to RPL (bond amount)
 *   2. Register member as a Rocket Pool node
 *   3. Guardian bootstrapMember (invite while bootstrap mode is open)
 *   4. Member actionJoin (lock RPL bond)
 *   5. Write deployments/odao-local.json
 *
 * Usage:
 *   PROVIDER_URL=http://127.0.0.1:PORT \
 *   PRIVATE_KEY=0x...guardian... \
 *   ODAO_PRIVATE_KEY=0x...member... \
 *   npx hardhat run scripts/devnet-7/bootstrap-odao.js --network custom
 *
 * Or pure node (no hardhat accounts needed beyond provider):
 *   PROVIDER_URL=... node scripts/devnet-7/bootstrap-odao.js
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '../..');
const DEPLOYMENT_FILE = process.env.DEPLOYMENT_FILE
    || path.join(ROOT, 'deployments', 'latest.json');
const OUTPUT_FILE = process.env.ODAO_OUTPUT
    || path.join(ROOT, 'deployments', 'odao-local.json');

// ethereum-package prefunded accounts (genesis_constants.star)
const DEFAULT_GUARDIAN_KEY = '0xbcdf20249abf0ed6d944c0288fad489e33f66b3960d9e6229c1cd214ed3bbe31';
const DEFAULT_MEMBER_KEY = '0x39725efee3fb28614de3bacaffe4cc4bd8c436257e2c8bb887c4b5c4be45e76d';

// Geth rejects eth_sendRawTransaction when gasLimit > txfeecap/rpc gas cap
// (default 16_777_216). Do NOT reuse DEPLOY_GAS_LIMIT (150M) for ordinary txs —
// let the provider estimate, with a small safety multiplier.
const TX_GAS_MULTIPLIER = Number(process.env.TX_GAS_MULTIPLIER || '1.2');
// Soft ceiling under typical geth 2^24-1 cap (leave headroom).
const TX_GAS_CAP = BigInt(process.env.TX_GAS_CAP || '16000000');

function normalizeKey(k) {
    if (!k) return k;
    return k.startsWith('0x') ? k : `0x${k}`;
}

function loadDeployment() {
    if (!fs.existsSync(DEPLOYMENT_FILE)) {
        throw new Error(`Missing deployment file: ${DEPLOYMENT_FILE}`);
    }
    return JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8'));
}

function addr(deployment, name) {
    const a = deployment.addresses && deployment.addresses[name];
    if (!a) throw new Error(`Deployment missing address for ${name}`);
    return a;
}

async function tx(sendPromise, label) {
    console.log(`  - ${label}...`);
    const sent = await sendPromise;
    const receipt = await sent.wait();
    if (receipt.status !== 1) {
        throw new Error(`${label} failed (status=${receipt.status}) tx=${sent.hash}`);
    }
    console.log(`    ok ${sent.hash}`);
    return receipt;
}

/**
 * Estimate gas for a contract method and clamp to a safe limit under geth's cap.
 * @param {ethers.Contract} contract
 * @param {string} method
 * @param {any[]} args
 * @param {ethers.Signer} signer
 * @param {object} [extra] value etc.
 */
async function gasOverrides(contract, method, args, signer, extra = {}) {
    const connected = contract.connect(signer);
    let estimated;
    try {
        estimated = await connected[method].estimateGas(...args, extra);
    } catch (e) {
        // Fall back to a moderate fixed limit if estimate fails (e.g. state edge cases).
        estimated = 3_000_000n;
        console.log(`    (estimateGas failed for ${method}, using ${estimated}: ${e.shortMessage || e.message})`);
    }
    const withBuffer = BigInt(Math.ceil(Number(estimated) * TX_GAS_MULTIPLIER));
    const gasLimit = withBuffer > TX_GAS_CAP ? TX_GAS_CAP : withBuffer;
    return { ...extra, gasLimit };
}

async function main() {
    const providerUrl = process.env.PROVIDER_URL || 'http://127.0.0.1:8545';
    const guardianKey = normalizeKey(process.env.PRIVATE_KEY || DEFAULT_GUARDIAN_KEY);
    const memberKey = normalizeKey(process.env.ODAO_PRIVATE_KEY || DEFAULT_MEMBER_KEY);
    const memberId = process.env.ODAO_MEMBER_ID || 'odao-0';
    const memberUrl = process.env.ODAO_MEMBER_URL || 'http://odao-0.local';
    const timezone = process.env.ODAO_TIMEZONE || 'Australia/Brisbane';

    const deployment = loadDeployment();
    const provider = new ethers.JsonRpcProvider(providerUrl);
    const guardian = new ethers.Wallet(guardianKey, provider);
    const member = new ethers.Wallet(memberKey, provider);

    console.log('oDAO bootstrap');
    console.log(`  RPC:      ${providerUrl}`);
    console.log(`  Guardian: ${guardian.address}`);
    console.log(`  Member:   ${member.address}`);
    console.log(`  Storage:  ${addr(deployment, 'RocketStorage')}`);

    const nodeManager = new ethers.Contract(
        addr(deployment, 'RocketNodeManager'),
        [
            'function registerNode(string timezoneLocation)',
            'function getNodeExists(address) view returns (bool)',
        ],
        provider,
    );

    const daoTrusted = new ethers.Contract(
        addr(deployment, 'RocketDAONodeTrusted'),
        [
            'function bootstrapMember(string id, string url, address nodeAddress)',
            'function getMemberIsValid(address) view returns (bool)',
            'function getMemberCount() view returns (uint256)',
            'function getMemberID(address) view returns (string)',
            'function getBootstrapModeDisabled() view returns (bool)',
        ],
        provider,
    );

    const daoActions = new ethers.Contract(
        addr(deployment, 'RocketDAONodeTrustedActions'),
        ['function actionJoin()'],
        provider,
    );

    const settingsMembers = new ethers.Contract(
        addr(deployment, 'RocketDAONodeTrustedSettingsMembers'),
        ['function getRPLBond() view returns (uint256)'],
        provider,
    );

    const dummyRpl = new ethers.Contract(
        addr(deployment, 'RocketTokenDummyRPL'),
        [
            'function balanceOf(address) view returns (uint256)',
            'function transfer(address to, uint256 amount) returns (bool)',
            'function approve(address spender, uint256 amount) returns (bool)',
        ],
        provider,
    );

    const rpl = new ethers.Contract(
        addr(deployment, 'RocketTokenRPL'),
        [
            'function balanceOf(address) view returns (uint256)',
            'function approve(address spender, uint256 amount) returns (bool)',
            'function swapTokens(uint256 amount)',
        ],
        provider,
    );

    // Already a member?
    if (await daoTrusted.getMemberIsValid(member.address)) {
        console.log('  Member is already a valid oDAO member; skipping bootstrap');
        writeOutput(deployment, guardian.address, member, memberId, memberUrl, providerUrl);
        return;
    }

    if (await daoTrusted.getBootstrapModeDisabled()) {
        throw new Error('Bootstrap mode is disabled; cannot invite oDAO member as guardian');
    }

    const bond = await settingsMembers.getRPLBond();
    console.log(`  RPL bond required: ${ethers.formatEther(bond)} RPL`);

    // Ensure member has enough RPL (via DRPL transfer + swap)
    const memberRpl = await rpl.balanceOf(member.address);
    if (memberRpl < bond) {
        const need = bond - memberRpl;
        console.log(`  Funding member with ${ethers.formatEther(need)} DRPL → RPL`);
        const guardianDrpl = await dummyRpl.balanceOf(guardian.address);
        if (guardianDrpl < need) {
            throw new Error(
                `Guardian DRPL balance ${ethers.formatEther(guardianDrpl)} < needed ${ethers.formatEther(need)}`,
            );
        }
        await tx(
            dummyRpl.connect(guardian).transfer(
                member.address,
                need,
                await gasOverrides(dummyRpl, 'transfer', [member.address, need], guardian),
            ),
            'Transfer DRPL to member',
        );
        const rplAddr = await rpl.getAddress();
        await tx(
            dummyRpl.connect(member).approve(
                rplAddr,
                need,
                await gasOverrides(dummyRpl, 'approve', [rplAddr, need], member),
            ),
            'Approve DRPL for swap',
        );
        await tx(
            rpl.connect(member).swapTokens(
                need,
                await gasOverrides(rpl, 'swapTokens', [need], member),
            ),
            'Swap DRPL → RPL',
        );
    } else {
        console.log(`  Member already has ${ethers.formatEther(memberRpl)} RPL`);
    }

    // Register node
    if (!(await nodeManager.getNodeExists(member.address))) {
        await tx(
            nodeManager.connect(member).registerNode(
                timezone,
                await gasOverrides(nodeManager, 'registerNode', [timezone], member),
            ),
            `Register node (${timezone})`,
        );
    } else {
        console.log('  Node already registered');
    }

    // Invite via guardian bootstrap
    const existingId = await daoTrusted.getMemberID(member.address);
    if (!existingId || existingId === '') {
        await tx(
            daoTrusted.connect(guardian).bootstrapMember(
                memberId,
                memberUrl,
                member.address,
                await gasOverrides(daoTrusted, 'bootstrapMember', [memberId, memberUrl, member.address], guardian),
            ),
            `bootstrapMember(${memberId})`,
        );
    } else {
        console.log(`  Invite already present (id=${existingId})`);
    }

    // Join with RPL bond
    if (!(await daoTrusted.getMemberIsValid(member.address))) {
        const actionsAddr = await daoActions.getAddress();
        await tx(
            rpl.connect(member).approve(
                actionsAddr,
                bond,
                await gasOverrides(rpl, 'approve', [actionsAddr, bond], member),
            ),
            'Approve RPL bond for RocketDAONodeTrustedActions',
        );
        await tx(
            daoActions.connect(member).actionJoin(
                await gasOverrides(daoActions, 'actionJoin', [], member),
            ),
            'actionJoin (accept invite + lock bond)',
        );
    }

    const valid = await daoTrusted.getMemberIsValid(member.address);
    const count = await daoTrusted.getMemberCount();
    if (!valid) {
        throw new Error('oDAO bootstrap finished but getMemberIsValid is false');
    }
    console.log(`  oDAO member valid=true; memberCount=${count}`);

    writeOutput(deployment, guardian.address, member, memberId, memberUrl, providerUrl);
    console.log(`  Wrote ${OUTPUT_FILE}`);
}

function writeOutput(deployment, guardianAddress, memberWallet, memberId, memberUrl, providerUrl) {
    const out = {
        chain: deployment.chain || 'kurtosis',
        rocketStorage: addr(deployment, 'RocketStorage'),
        guardian: guardianAddress,
        member: {
            address: memberWallet.address,
            id: memberId,
            url: memberUrl,
            // private key for Smart Node wallet import (local dev only)
            privateKey: memberWallet.privateKey,
        },
        contracts: {
            RocketDAONodeTrusted: addr(deployment, 'RocketDAONodeTrusted'),
            RocketDAONodeTrustedActions: addr(deployment, 'RocketDAONodeTrustedActions'),
            RocketNodeManager: addr(deployment, 'RocketNodeManager'),
            RocketTokenRPL: addr(deployment, 'RocketTokenRPL'),
        },
        providerUrlAtBootstrap: providerUrl,
        createdAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
