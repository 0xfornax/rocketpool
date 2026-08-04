/**
 * Submit an *incorrect* oDAO exit challenge for a megapool validator that is
 * still active on the beacon chain (not exiting). Used to exercise the
 * Smart Node defend path (notifyNotExit / unlock).
 *
 * Requires:
 *   - oDAO member (trusted node) with bootstrap still able to challenge
 *   - Validator staked, not already exiting/exited/locked on the megapool
 *
 * Usage:
 *   PROVIDER_URL=http://127.0.0.1:32003 \
 *   ODAO_PRIVATE_KEY=0x... \
 *   MEGAPOOL=0x... VALIDATOR_ID=1 \
 *   node scripts/devnet-7/challenge-exit-incorrect.js
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '../..');
const DEPLOYMENT_FILE = process.env.DEPLOYMENT_FILE
    || path.join(ROOT, 'deployments', 'latest.json');
const ODAO_FILE = process.env.ODAO_FILE
    || path.join(ROOT, 'deployments', 'odao-local.json');

const DEFAULT_MEMBER_KEY = '0x39725efee3fb28614de3bacaffe4cc4bd8c436257e2c8bb887c4b5c4be45e76d';

function loadJson(p) {
    if (!fs.existsSync(p)) throw new Error(`missing ${p}`);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function main() {
    const providerUrl = process.env.PROVIDER_URL || process.env.EL_HTTP;
    if (!providerUrl) throw new Error('PROVIDER_URL (or EL_HTTP) required');

    const deployment = loadJson(DEPLOYMENT_FILE);
    let odao = {};
    try { odao = loadJson(ODAO_FILE); } catch (_) { /* optional */ }

    const memberKey = (process.env.ODAO_PRIVATE_KEY || odao.member?.privateKey || DEFAULT_MEMBER_KEY);
    const key = memberKey.startsWith('0x') ? memberKey : `0x${memberKey}`;

    const provider = new ethers.JsonRpcProvider(providerUrl);
    const challenger = new ethers.Wallet(key, provider);

    const megapool = process.env.MEGAPOOL
        || process.env.MEGAPOOL_ADDRESS
        || '0x0DFB735d953453198D0Cd79546464455b40D3645';
    const validatorId = Number(process.env.VALIDATOR_ID ?? '1');

    const managerAddr = deployment.addresses.RocketMegapoolManager;
    if (!managerAddr) throw new Error('RocketMegapoolManager missing from latest.json');

    const manager = new ethers.Contract(managerAddr, [
        'function challengeExit((address megapool,uint32[] validatorIds)[] challenges)',
        'function getLastChallenger() view returns (address)',
    ], challenger);

    const mega = new ethers.Contract(megapool, [
        'function getValidatorInfo(uint32) view returns (tuple(uint32 lastAssignmentTime,uint32 lastRequestedValue,uint32 lastRequestedBond,uint32 depositValue,bool staked,bool exited,bool inQueue,bool inPrestake,bool expressUsed,bool dissolved,bool exiting,bool locked,uint64 exitBalance,uint64 lockedTime))',
        'function getLockedValidatorCount() view returns (uint32)',
        'function getValidatorPubkey(uint32) view returns (bytes)',
    ], provider);

    console.log('Incorrect exit challenge (devnet)');
    console.log(`  RPC:          ${providerUrl}`);
    console.log(`  Challenger:   ${challenger.address}`);
    console.log(`  Manager:      ${managerAddr}`);
    console.log(`  Megapool:     ${megapool}`);
    console.log(`  Validator ID: ${validatorId}`);

    const bal = await provider.getBalance(challenger.address);
    console.log(`  Challenger ETH: ${ethers.formatEther(bal)}`);
    if (bal === 0n) throw new Error('challenger has 0 ETH for gas');

    let last = ethers.ZeroAddress;
    try { last = await manager.getLastChallenger(); } catch (_) { /* older artifact */ }
    console.log(`  Last challenger: ${last}`);
    if (last.toLowerCase() === challenger.address.toLowerCase()) {
        throw new Error('This oDAO member was the last to challenge; need a different trusted node');
    }

    const info = await mega.getValidatorInfo(validatorId);
    console.log('  Validator state:', {
        staked: info.staked,
        exiting: info.exiting,
        exited: info.exited,
        locked: info.locked,
    });
    if (!info.staked) throw new Error('validator not staked');
    if (info.exiting) throw new Error('validator already exiting on megapool — pick a non-exiting id');
    if (info.exited) throw new Error('validator already exited');
    if (info.locked) {
        console.log('  (already locked — challenge will refresh lockedTime)');
    }

    const challenges = [{
        megapool,
        validatorIds: [validatorId],
    }];

    console.log('  - challengeExit(...)');
    let gasLimit = 500_000n;
    try {
        const est = await manager.challengeExit.estimateGas(challenges);
        gasLimit = (est * 150n) / 100n;
        console.log(`    estimateGas=${est} gasLimit=${gasLimit}`);
    } catch (e) {
        console.log(`    estimateGas failed: ${e.reason || e.shortMessage || e.message}`);
        try {
            await manager.challengeExit.staticCall(challenges);
        } catch (e2) {
            throw new Error(`challengeExit would revert: ${e2.reason || e2.shortMessage || e2.message}`);
        }
    }

    const tx = await manager.challengeExit(challenges, { gasLimit });
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error(`challengeExit failed status=${rc.status}`);
    console.log(`    ok ${tx.hash}`);

    const after = await mega.getValidatorInfo(validatorId);
    console.log('  After challenge:');
    console.log(`    locked=${after.locked} lockedTime=${after.lockedTime}`);
    console.log(`    lockedCount=${await mega.getLockedValidatorCount()}`);
    try {
        console.log(`    lastChallenger=${await manager.getLastChallenger()}`);
    } catch (_) { /* */ }

    console.log('');
    console.log('Challenge submitted (incorrect — beacon validator is still active).');
    console.log('Smart Node defend task should call notifyNotExit with a not-exiting proof and unlock it.');
    console.log('Watch: rocketpoold log for "incorrect exit challenge" / defend.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
