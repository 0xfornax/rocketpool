/**
 * Force-submit an oDAO proposalUpgrade (type upgradeContract) on a Kurtosis deploy.
 *
 * propose() requires getMemberCount() >= getMemberMinRequired() (hardcoded 3).
 * This script:
 *   1. Shortens oDAO proposal cooldown / vote delay / vote window (bootstrap still open)
 *   2. Invites a 3rd trusted node if needed (ethereum-package prefunded #1)
 *   3. Deploys a fresh RocketAuctionManager
 *   4. Submits propose(proposalUpgrade('upgradeContract', 'rocketAuctionManager', ...))
 *      from odao-0 (RP_DIR / odao-local.json)
 *
 * Usage:
 *   PROVIDER_URL=http://127.0.0.1:32003 node scripts/devnet-7/propose-odao-upgrade.js
 *
 * Optional:
 *   ODAO_VOTE_DELAY_SECS   (default 300)
 *   ODAO_VOTE_TIME_SECS    (default 900)
 *   ODAO_COOLDOWN_SECS     (default 10)
 *   UPGRADE_CONTRACT_NAME  (default rocketAuctionManager)
 *   SKIP_THIRD_MEMBER=1    fail instead of inviting prefunded #1
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const pako = require('pako');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT_DIR = __dirname;
const DEPLOYMENT_FILE = process.env.DEPLOYMENT_FILE
    || path.join(ROOT, 'deployments', 'latest.json');
const ODAO_FILE = process.env.ODAO_OUTPUT
    || path.join(ROOT, 'deployments', 'odao-local.json');

const DEFAULT_GUARDIAN_KEY = '0xbcdf20249abf0ed6d944c0288fad489e33f66b3960d9e6229c1cd214ed3bbe31';
// ethereum-package prefunded account #1 — unused by odao-0 / odao-1.
const DEFAULT_THIRD_MEMBER_KEY = '0x39725efee3fb28614de3bacaffe4cc4bd8c436257e2c8bb887c4b5c4be45e76d';

const TX_GAS_MULTIPLIER = Number(process.env.TX_GAS_MULTIPLIER || '1.2');
const TX_GAS_CAP = BigInt(process.env.TX_GAS_CAP || '16000000');

const VOTE_DELAY_SECS = BigInt(process.env.ODAO_VOTE_DELAY_SECS || '300');
const VOTE_TIME_SECS = BigInt(process.env.ODAO_VOTE_TIME_SECS || '900');
const COOLDOWN_SECS = BigInt(process.env.ODAO_COOLDOWN_SECS || '10');
const UPGRADE_CONTRACT_NAME = process.env.UPGRADE_CONTRACT_NAME || 'rocketAuctionManager';
const UPGRADE_TYPE = process.env.UPGRADE_TYPE || 'upgradeContract';

function normalizeKey(k) {
    if (!k) return k;
    return k.startsWith('0x') ? k : `0x${k}`;
}

function compressABI(abi) {
    return Buffer.from(pako.deflate(JSON.stringify(abi))).toString('base64');
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

function loadArtifact(solPath, contractName) {
    const p = path.join(ROOT, 'artifacts', solPath, `${contractName}.json`);
    if (!fs.existsSync(p)) {
        throw new Error(`Artifact missing: ${p} (run npx hardhat compile)`);
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function hardhatNameForNetwork(name) {
    // Storage contract name → Hardhat artifact / latest.json address key.
    const map = {
        rocketAuctionManager: 'RocketAuctionManager',
        rocketNodeManager: 'RocketNodeManager',
        rocketClaimDAO: 'RocketClaimDAO',
        rocketMinipoolManager: 'RocketMinipoolManager',
        rocketNetworkBalances: 'RocketNetworkBalances',
        rocketNetworkPrices: 'RocketNetworkPrices',
    };
    if (map[name]) return map[name];
    return name.charAt(0).toUpperCase() + name.slice(1);
}

function artifactPathFor(hardhatName) {
    const map = {
        RocketAuctionManager: 'contracts/contract/auction/RocketAuctionManager.sol',
        RocketNodeManager: 'contracts/contract/node/RocketNodeManager.sol',
        RocketClaimDAO: 'contracts/contract/rewards/RocketClaimDAO.sol',
        RocketMinipoolManager: 'contracts/contract/minipool/RocketMinipoolManager.sol',
        RocketNetworkBalances: 'contracts/contract/network/RocketNetworkBalances.sol',
        RocketNetworkPrices: 'contracts/contract/network/RocketNetworkPrices.sol',
    };
    if (!map[hardhatName]) {
        throw new Error(
            `No artifact path mapping for ${hardhatName}. Set UPGRADE_CONTRACT_NAME to a known contract.`,
        );
    }
    return map[hardhatName];
}

async function tx(sendPromise, label) {
    console.log(`  - ${label}...`);
    const sent = await sendPromise;
    const receipt = await sent.wait();
    if (receipt.status !== 1) {
        throw new Error(`${label} failed (status=${receipt.status}) tx=${sent.hash}`);
    }
    console.log(`    ok ${sent.hash}`);
    return { sent, receipt };
}

async function gasOverrides(contract, method, args, signer, extra = {}) {
    const connected = contract.connect(signer);
    let estimated;
    try {
        estimated = await connected[method].estimateGas(...args, extra);
    } catch (e) {
        estimated = 3_000_000n;
        console.log(`    (estimateGas failed for ${method}, using ${estimated}: ${e.shortMessage || e.message})`);
    }
    const withBuffer = BigInt(Math.ceil(Number(estimated) * TX_GAS_MULTIPLIER));
    const gasLimit = withBuffer > TX_GAS_CAP ? TX_GAS_CAP : withBuffer;
    return { ...extra, gasLimit };
}

function resolveProposerKey() {
    if (process.env.ODAO_PROPOSER_PRIVATE_KEY) {
        return normalizeKey(process.env.ODAO_PROPOSER_PRIVATE_KEY);
    }
    if (fs.existsSync(ODAO_FILE)) {
        const odao = JSON.parse(fs.readFileSync(ODAO_FILE, 'utf8'));
        if (odao.member && odao.member.privateKey) {
            return normalizeKey(odao.member.privateKey);
        }
    }
    throw new Error(
        `No proposer key (set ODAO_PROPOSER_PRIVATE_KEY or write ${ODAO_FILE})`,
    );
}

function inviteThirdMember(providerUrl, guardianKey) {
    const thirdKey = normalizeKey(process.env.ODAO_THIRD_MEMBER_KEY || DEFAULT_THIRD_MEMBER_KEY);
    console.log('  Inviting 3rd oDAO member via bootstrap-odao.js (prefunded #1)');
    const env = {
        ...process.env,
        PROVIDER_URL: providerUrl,
        PRIVATE_KEY: guardianKey,
        ODAO_PRIVATE_KEY: thirdKey,
        ODAO_MEMBER_ID: process.env.ODAO_THIRD_MEMBER_ID || 'odao-2',
        ODAO_MEMBER_URL: process.env.ODAO_THIRD_MEMBER_URL || 'http://odao-2.local',
        ODAO_OUTPUT: process.env.ODAO_THIRD_OUTPUT
            || path.join(ROOT, 'deployments', 'odao-local-member2.json'),
    };
    // bootstrap-odao.js also reads RP_DIR when ODAO_PRIVATE_KEY is unset; we set the key.
    const result = spawnSync(process.execPath, [path.join(SCRIPT_DIR, 'bootstrap-odao.js')], {
        cwd: ROOT,
        env,
        stdio: 'inherit',
    });
    if (result.status !== 0) {
        throw new Error(`bootstrap-odao.js for 3rd member exited ${result.status}`);
    }
}

async function main() {
    const providerUrl = process.env.PROVIDER_URL || 'http://127.0.0.1:32003';
    const guardianKey = normalizeKey(process.env.PRIVATE_KEY || DEFAULT_GUARDIAN_KEY);
    const deployment = loadDeployment();
    const provider = new ethers.JsonRpcProvider(providerUrl);
    const guardian = new ethers.Wallet(guardianKey, provider);
    const proposerKey = resolveProposerKey();
    const proposer = new ethers.Wallet(proposerKey, provider);

    const daoTrusted = new ethers.Contract(
        addr(deployment, 'RocketDAONodeTrusted'),
        [
            'function getMemberCount() view returns (uint256)',
            'function getMemberMinRequired() view returns (uint256)',
            'function getMemberIsValid(address) view returns (bool)',
            'function getBootstrapModeDisabled() view returns (bool)',
            'function bootstrapSettingUint(string settingContractName, string settingPath, uint256 value)',
            'function getMemberLastProposalTime(address) view returns (uint256)',
        ],
        provider,
    );
    const settings = new ethers.Contract(
        addr(deployment, 'RocketDAONodeTrustedSettingsProposals'),
        [
            'function getCooldownTime() view returns (uint256)',
            'function getVoteTime() view returns (uint256)',
            'function getVoteDelayTime() view returns (uint256)',
        ],
        provider,
    );
    const daoProposals = new ethers.Contract(
        addr(deployment, 'RocketDAONodeTrustedProposals'),
        [
            'function propose(string proposalMessage, bytes payload) returns (uint256)',
            'function proposalUpgrade(string _type, string _name, string _contractAbi, address _contractAddress)',
        ],
        provider,
    );
    const daoProposal = new ethers.Contract(
        addr(deployment, 'RocketDAOProposal'),
        [
            'function getTotal() view returns (uint256)',
            'function getMessage(uint256) view returns (string)',
            'function getStart(uint256) view returns (uint256)',
            'function getEnd(uint256) view returns (uint256)',
            'function getState(uint256) view returns (uint8)',
            'function getProposer(uint256) view returns (address)',
            'function getDAO(uint256) view returns (string)',
        ],
        provider,
    );

    console.log('oDAO upgrade-contract proposal');
    console.log(`  RPC:       ${providerUrl}`);
    console.log(`  Guardian:  ${guardian.address}`);
    console.log(`  Proposer:  ${proposer.address}`);
    console.log(`  Type:      ${UPGRADE_TYPE}`);
    console.log(`  Contract:  ${UPGRADE_CONTRACT_NAME}`);

    const minRequired = await daoTrusted.getMemberMinRequired();
    let count = await daoTrusted.getMemberCount();
    const bootstrapDisabled = await daoTrusted.getBootstrapModeDisabled();
    console.log(`  Members:   ${count} (min for propose: ${minRequired})`);
    console.log(`  Bootstrap: ${bootstrapDisabled ? 'disabled' : 'open'}`);

    if (!await daoTrusted.getMemberIsValid(proposer.address)) {
        throw new Error(`Proposer ${proposer.address} is not a valid oDAO member`);
    }

    // --- Shorten oDAO proposal windows (these are independent of pDAO settings) ---
    if (bootstrapDisabled) {
        const delay = await settings.getVoteDelayTime();
        if (delay > VOTE_DELAY_SECS) {
            console.log(
                `  warning: bootstrap closed; oDAO vote delay is ${delay}s (wanted ${VOTE_DELAY_SECS}s)`,
            );
        }
    } else {
        const patches = [
            { path: 'proposal.cooldown.time', getter: () => settings.getCooldownTime(), want: COOLDOWN_SECS, label: 'cooldown' },
            { path: 'proposal.vote.delay.time', getter: () => settings.getVoteDelayTime(), want: VOTE_DELAY_SECS, label: 'vote delay' },
            { path: 'proposal.vote.time', getter: () => settings.getVoteTime(), want: VOTE_TIME_SECS, label: 'vote time' },
        ];
        for (const { path: settingPath, getter, want, label } of patches) {
            const current = await getter();
            if (current === want) {
                console.log(`  - ${settingPath} already ${current}s`);
                continue;
            }
            await tx(
                daoTrusted.connect(guardian).bootstrapSettingUint(
                    'rocketDAONodeTrustedSettingsProposals',
                    settingPath,
                    want,
                    await gasOverrides(
                        daoTrusted,
                        'bootstrapSettingUint',
                        ['rocketDAONodeTrustedSettingsProposals', settingPath, want],
                        guardian,
                    ),
                ),
                `bootstrapSettingUint ${label} ${current}s → ${want}s`,
            );
        }
    }

    // --- Ensure min member count ---
    if (count < minRequired) {
        if (process.env.SKIP_THIRD_MEMBER === '1') {
            throw new Error(
                `oDAO member count ${count} < min ${minRequired}; propose() would revert. `
                + 'Unset SKIP_THIRD_MEMBER or invite another trusted node.',
            );
        }
        if (bootstrapDisabled) {
            throw new Error(
                `Need ${minRequired} members to propose, have ${count}, and bootstrap is closed`,
            );
        }
        inviteThirdMember(providerUrl, guardianKey);
        count = await daoTrusted.getMemberCount();
        if (count < minRequired) {
            throw new Error(`Still only ${count} members after 3rd-member invite (need ${minRequired})`);
        }
        console.log(`  Members now ${count}`);
    }

    // --- Deploy a fresh copy of the target contract ---
    const hardhatName = hardhatNameForNetwork(UPGRADE_CONTRACT_NAME);
    const existingAddr = addr(deployment, hardhatName);
    const art = loadArtifact(artifactPathFor(hardhatName), hardhatName);
    const factory = new ethers.ContractFactory(art.abi, art.bytecode, guardian);
    const rocketStorage = addr(deployment, 'RocketStorage');
    console.log(`  Existing ${UPGRADE_CONTRACT_NAME} @ ${existingAddr}`);
    console.log(`  - Deploying new ${hardhatName}...`);
    const deployTx = await factory.getDeployTransaction(rocketStorage);
    let gasLimit;
    try {
        const estimated = await guardian.estimateGas(deployTx);
        const buffered = (estimated * 125n) / 100n;
        gasLimit = buffered > TX_GAS_CAP ? TX_GAS_CAP : buffered;
        if (gasLimit < estimated) gasLimit = estimated;
    } catch (e) {
        gasLimit = 8_000_000n;
        console.log(`    (deploy estimateGas failed: ${e.shortMessage || e.message}; using ${gasLimit})`);
    }
    const newContract = await factory.deploy(rocketStorage, { gasLimit });
    await newContract.waitForDeployment();
    const newAddr = await newContract.getAddress();
    const code = await provider.getCode(newAddr);
    if (!code || code === '0x') {
        throw new Error(`${hardhatName} deployed to ${newAddr} but has no code`);
    }
    console.log(`    ${hardhatName} @ ${newAddr}`);

    const compressedAbi = compressABI(art.abi);
    const payload = daoProposals.interface.encodeFunctionData('proposalUpgrade', [
        UPGRADE_TYPE,
        UPGRADE_CONTRACT_NAME,
        compressedAbi,
        newAddr,
    ]);
    const message = process.env.PROPOSAL_MESSAGE
        || `Kurtosis: ${UPGRADE_TYPE} ${UPGRADE_CONTRACT_NAME} → ${newAddr}`;

    const before = await daoProposal.getTotal();
    const id = await daoProposals.connect(proposer).propose.staticCall(message, payload);
    await tx(
        daoProposals.connect(proposer).propose(
            message,
            payload,
            await gasOverrides(daoProposals, 'propose', [message, payload], proposer),
        ),
        `propose() upgrade ${UPGRADE_CONTRACT_NAME}`,
    );
    const after = await daoProposal.getTotal();
    if (after !== before + 1n) {
        throw new Error(`Proposal count did not increment (${before} → ${after})`);
    }

    const [start, end, state, daoName, proposerAddr] = await Promise.all([
        daoProposal.getStart(id),
        daoProposal.getEnd(id),
        daoProposal.getState(id),
        daoProposal.getDAO(id),
        daoProposal.getProposer(id),
    ]);
    const states = ['Pending', 'Active', 'Cancelled', 'Defeated', 'Succeeded', 'Expired', 'Executed'];
    const now = (await provider.getBlock('latest')).timestamp;
    const voteIn = start > BigInt(now) ? Number(start - BigInt(now)) : 0;

    const out = {
        chain: deployment.chain || 'kurtosis',
        rocketStorage,
        proposalId: id.toString(),
        dao: daoName,
        proposer: proposerAddr,
        state: states[Number(state)] || String(state),
        message,
        upgradeType: UPGRADE_TYPE,
        contractName: UPGRADE_CONTRACT_NAME,
        oldAddress: existingAddr,
        newAddress: newAddr,
        voteStartsAt: Number(start),
        voteEndsAt: Number(end),
        voteStartsInSecs: voteIn,
        txTime: new Date().toISOString(),
    };
    const outFile = process.env.PROPOSAL_OUTPUT
        || path.join(ROOT, 'deployments', 'odao-upgrade-proposal.json');
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2));

    console.log(`  Proposal #${id}  state=${out.state}  dao=${daoName}`);
    console.log(`  Vote starts in ${voteIn}s (unix ${start}) and ends unix ${end}`);
    console.log(`  Wrote ${outFile}`);
    console.log('  After the delay, vote from odao-0 and odao-1:');
    console.log(`    rocketpool odao proposals vote -p ${id} -s yes -y`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
