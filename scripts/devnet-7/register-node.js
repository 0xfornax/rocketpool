/**
 * Register the /srv/rocketpool3 Smart Node wallet as a Rocket Pool node.
 *
 * Decrypts the Rocket Pool v4 keystore (encrypted BIP39 seed → m/44'/60'/0'/0/%d),
 * then calls RocketNodeManager.registerNode if not already registered.
 * After that (or if already registered):
 *   - RocketNodeStaking.setRPLLockingAllowed(node, true)  (allow-rpl-locking)
 *   - approve + stakeRPL(STAKE_RPL)                       (default 2000)
 *
 * Intended to run after seed-devnet.js (ETH/RPL funded to the wallet address).
 *
 * Usage:
 *   PROVIDER_URL=http://127.0.0.1:PORT \
 *   node scripts/devnet-7/register-node.js
 *
 * Env:
 *   RP_DIR           Smart Node data root (default: /srv/rocketpool3)
 *   TIMEZONE         registerNode timezone (default: Australia/Brisbane)
 *   STAKE_RPL        RPL to stake after register (default: 2000; 0 skips)
 *   SKIP_RPL_LOCKING=1  skip setRPLLockingAllowed
 *   OPERATOR_PRIVATE_KEY  override signer for lock+stake (default: RP_DIR node account)
 *   DEPLOYMENT_FILE  deployments/latest.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');
const { ensureGuardianRpl, RPL_ABI, DRPL_ABI } = require('./rpl-funding');

const ROOT = path.resolve(__dirname, '../..');
const DEPLOYMENT_FILE = process.env.DEPLOYMENT_FILE
    || path.join(ROOT, 'deployments', 'latest.json');
const RP_DIR = process.env.RP_DIR || '/srv/rocketpool3';
const TIMEZONE = process.env.TIMEZONE || process.env.ODAO_TIMEZONE || 'Australia/Brisbane';
const TX_GAS_CAP = BigInt(process.env.TX_GAS_CAP || '16000000');
const STAKE_RPL = ethers.parseEther(process.env.STAKE_RPL || '2000');
const SKIP_RPL_LOCKING = process.env.SKIP_RPL_LOCKING === '1';
// Default seed / Smart Node account 0. Compared against the derived operator.
const DEFAULT_OPERATOR = '0xc7EBC35C761bFbaE449973E226CE3295B9B7f996';
const DEFAULT_GUARDIAN_KEY = '0xbcdf20249abf0ed6d944c0288fad489e33f66b3960d9e6229c1cd214ed3bbe31';

function normalizeKey(k) {
    if (!k) return k;
    return k.startsWith('0x') ? k : `0x${k}`;
}

/**
 * Node operator account index from a Smart Node v4 keystore.
 * walletIndex is the node account (omitted when 0 because of Go omitempty).
 * next_account is the next validator key index — never the node account.
 */
function nodeAccountIndex(keystore) {
    if (keystore.walletIndex !== undefined && keystore.walletIndex !== null && keystore.walletIndex !== '') {
        return String(keystore.walletIndex);
    }
    return '0';
}

const NODE_MANAGER_ABI = [
    'function registerNode(string timezoneLocation)',
    'function getNodeExists(address nodeAddress) view returns (bool)',
    'function getNodeTimezoneLocation(address nodeAddress) view returns (string)',
];
const NODE_STAKING_ABI = [
    'function getRPLLockingAllowed(address nodeAddress) view returns (bool)',
    'function setRPLLockingAllowed(address nodeAddress, bool allowed)',
    'function stakeRPL(uint256 amount)',
    'function getNodeStakedRPL(address nodeAddress) view returns (uint256)',
];
const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
];

function loadDeployment() {
    if (!fs.existsSync(DEPLOYMENT_FILE)) {
        throw new Error(`Missing deployment file: ${DEPLOYMENT_FILE}`);
    }
    return JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8'));
}

/**
 * Decrypt Rocket Pool CLI wallet v4 keystore (encrypted 64-byte BIP39 seed).
 * Returns the node operator HD account (walletIndex, default 0).
 */
function loadSmartNodeWallet(rpDir) {
    const walletPath = path.join(rpDir, 'data', 'wallet');
    const passwordPath = path.join(rpDir, 'data', 'password');
    if (!fs.existsSync(walletPath)) {
        throw new Error(`Smart Node wallet missing: ${walletPath}`);
    }
    if (!fs.existsSync(passwordPath)) {
        throw new Error(`Smart Node password missing: ${passwordPath}`);
    }
    const w = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
    const password = fs.readFileSync(passwordPath, 'utf8').replace(/\n$/, '');
    const cryptoObj = w.crypto || w.Crypto;
    if (!cryptoObj) {
        throw new Error('Wallet file has no crypto section');
    }

    const kdf = cryptoObj.kdf;
    const cipher = cryptoObj.cipher;
    if (!kdf || kdf.function !== 'pbkdf2') {
        throw new Error(`Unsupported kdf: ${kdf && kdf.function}`);
    }
    const salt = Buffer.from(kdf.params.salt, 'hex');
    const derived = crypto.pbkdf2Sync(
        password,
        salt,
        kdf.params.c,
        kdf.params.dklen,
        'sha256',
    );
    const ciphertext = Buffer.from(cipher.message, 'hex');
    const macExpected = cryptoObj.checksum.message;
    const mac = crypto.createHash('sha256')
        .update(Buffer.concat([derived.subarray(16, 32), ciphertext]))
        .digest('hex');
    if (mac !== macExpected) {
        throw new Error('Wallet password is incorrect (MAC mismatch)');
    }
    const iv = Buffer.from(cipher.params.iv, 'hex');
    // AES-128-CTR: Node wants 16-byte key; counter from IV
    const decipher = crypto.createDecipheriv('aes-128-ctr', derived.subarray(0, 16), iv);
    const seed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (seed.length !== 64) {
        throw new Error(`Unexpected seed length ${seed.length} (want 64)`);
    }

    // ethers v6: HDNodeWallet from seed
    const pathTpl = w.derivationPath || "m/44'/60'/0'/0/%d";
    const walletIndex = nodeAccountIndex(w);
    const accountPath = pathTpl.includes('%d')
        ? pathTpl.replace('%d', walletIndex)
        : (pathTpl || "m/44'/60'/0'/0/0");
    const root = ethers.HDNodeWallet.fromSeed(seed);
    // derivePath expects path without leading "m/"
    const rel = accountPath.startsWith('m/') ? accountPath.slice(2) : accountPath;
    return root.derivePath(rel);
}

async function gasOverrides(contract, method, args, signer) {
    const connected = contract.connect(signer);
    let estimated;
    try {
        estimated = await connected[method].estimateGas(...args);
    } catch (e) {
        estimated = 1_500_000n;
        console.log(`  (estimateGas failed for ${method}: ${e.shortMessage || e.message}; using ${estimated})`);
    }
    const buffered = (estimated * 12n) / 10n;
    return { gasLimit: buffered > TX_GAS_CAP ? TX_GAS_CAP : buffered };
}

async function fundOperatorRpl(provider, deployment, operator, amount) {
    const guardianKey = normalizeKey(process.env.PRIVATE_KEY || DEFAULT_GUARDIAN_KEY);
    const guardian = new ethers.Wallet(guardianKey, provider);
    const dummyAddr = deployment.addresses.RocketTokenDummyRPL;
    const rplAddr = deployment.addresses.RocketTokenRPL;
    if (!dummyAddr || !rplAddr) {
        throw new Error('RocketTokenDummyRPL or RocketTokenRPL missing from latest.json');
    }
    const dummyRpl = new ethers.Contract(dummyAddr, DRPL_ABI, guardian);
    const rpl = new ethers.Contract(rplAddr, RPL_ABI, guardian);
    if (operator.address.toLowerCase() === guardian.address.toLowerCase()) {
        await ensureGuardianRpl({ guardian, rpl, dummyRpl, amount: await rpl.balanceOf(guardian.address) + amount });
        return;
    }
    await ensureGuardianRpl({ guardian, rpl, dummyRpl, amount });
    console.log(`  - Transfer ${ethers.formatEther(amount)} RPL to ${operator.address}...`);
    const opts = await gasOverrides(rpl, 'transfer', [operator.address, amount], guardian);
    const tx = await rpl.transfer(operator.address, amount, opts);
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error(`RPL transfer failed tx=${tx.hash}`);
    console.log(`    ok ${tx.hash}`);
}

async function main() {
    const providerUrl = process.env.PROVIDER_URL;
    if (!providerUrl) throw new Error('PROVIDER_URL is required');

    const deployment = loadDeployment();
    const nodeManagerAddr = deployment.addresses && deployment.addresses.RocketNodeManager;
    if (!nodeManagerAddr) {
        throw new Error('RocketNodeManager missing from latest.json');
    }

    const provider = new ethers.JsonRpcProvider(providerUrl);
    const code = await provider.getCode(nodeManagerAddr);
    if (!code || code === '0x') {
        throw new Error(
            `RocketNodeManager has no code at ${nodeManagerAddr} on ${providerUrl} — deploy contracts first`,
        );
    }

    const hdWallet = loadSmartNodeWallet(RP_DIR);
    const wallet = hdWallet.connect(provider);
    console.log('Register Smart Node as RP node');
    console.log(`  RPC:         ${providerUrl}`);
    console.log(`  RP_DIR:      ${RP_DIR}`);
    console.log(`  Wallet:      ${wallet.address} (node account, not validator next_account)`);
    console.log(`  NodeManager: ${nodeManagerAddr}`);
    console.log(`  Timezone:    ${TIMEZONE}`);

    const nodeManager = new ethers.Contract(nodeManagerAddr, NODE_MANAGER_ABI, provider);
    if (await nodeManager.getNodeExists(wallet.address)) {
        const tz = await nodeManager.getNodeTimezoneLocation(wallet.address);
        console.log(`  Already registered (timezone=${tz})`);
    } else {
        const bal = await provider.getBalance(wallet.address);
        console.log(`  ETH balance: ${ethers.formatEther(bal)}`);
        if (bal === 0n) {
            console.log(
                `  - RP_DIR wallet ${wallet.address} has 0 ETH; skip register `
                + `(will still allow-rpl-locking + stake if operator has ETH)`,
            );
        } else {

        const opts = await gasOverrides(nodeManager, 'registerNode', [TIMEZONE], wallet);
        console.log(`  - registerNode(${TIMEZONE}) gasLimit=${opts.gasLimit}...`);
        const tx = await nodeManager.connect(wallet).registerNode(TIMEZONE, opts);
        const receipt = await tx.wait();
        if (receipt.status !== 1) {
            throw new Error(`registerNode failed status=${receipt.status} tx=${tx.hash}`);
        }
        console.log(`    ok ${tx.hash}`);

        const exists = await nodeManager.getNodeExists(wallet.address);
        if (!exists) {
            throw new Error('registerNode mined but getNodeExists is still false');
        }
        console.log('  Node registered successfully');
        }
    }

    const stakingAddr = deployment.addresses.RocketNodeStaking;
    const rplAddr = deployment.addresses.RocketTokenRPL;
    if (!stakingAddr || !rplAddr) {
        throw new Error('RocketNodeStaking or RocketTokenRPL missing from latest.json');
    }

    // Lock + stake on the Smart Node account (HD wallet). OPERATOR_PRIVATE_KEY
    // is the only override — do not pick up odao-smartnode.env, whose member
    // may be a different derivation index than the node operator.
    const operatorKey = normalizeKey(process.env.OPERATOR_PRIVATE_KEY || hdWallet.privateKey);
    const operator = new ethers.Wallet(operatorKey, provider);
    const expectedOp = (process.env.SEED_ADDRESS || DEFAULT_OPERATOR).toLowerCase();
    if (operator.address.toLowerCase() !== expectedOp) {
        console.log(
            `  NOTE: operator ${operator.address} differs from seed ${expectedOp}`,
        );
    }
    console.log(`  Operator:    ${operator.address} (allow-rpl-locking + stake)`);

    const opManager = nodeManager.connect(provider);
    if (!(await opManager.getNodeExists(operator.address))) {
        const opEth = await provider.getBalance(operator.address);
        if (opEth === 0n) {
            throw new Error(
                `Operator ${operator.address} is not registered and has 0 ETH`,
            );
        }
        const opts = await gasOverrides(nodeManager, 'registerNode', [TIMEZONE], operator);
        console.log(`  - registerNode(${TIMEZONE}) for operator gasLimit=${opts.gasLimit}...`);
        const tx = await nodeManager.connect(operator).registerNode(TIMEZONE, opts);
        await tx.wait();
        console.log(`    ok ${tx.hash}`);
    }

    const staking = new ethers.Contract(stakingAddr, NODE_STAKING_ABI, operator);
    const rpl = new ethers.Contract(rplAddr, ERC20_ABI, operator);

    if (!SKIP_RPL_LOCKING) {
        const allowed = await staking.getRPLLockingAllowed(operator.address);
        if (allowed) {
            console.log('  - RPL locking already allowed');
        } else {
            const opts = await gasOverrides(staking, 'setRPLLockingAllowed', [operator.address, true], operator);
            console.log(`  - setRPLLockingAllowed(true) gasLimit=${opts.gasLimit}...`);
            const tx = await staking.setRPLLockingAllowed(operator.address, true, opts);
            const receipt = await tx.wait();
            if (receipt.status !== 1) {
                throw new Error(`setRPLLockingAllowed failed status=${receipt.status} tx=${tx.hash}`);
            }
            console.log(`    ok ${tx.hash}`);
        }
    }

    if (STAKE_RPL > 0n) {
        const already = await staking.getNodeStakedRPL(operator.address);
        if (already >= STAKE_RPL) {
            console.log(`  - already staked ${ethers.formatEther(already)} RPL (>= ${ethers.formatEther(STAKE_RPL)}); skip`);
        } else {
            const need = STAKE_RPL - already;
            let rplBal = await rpl.balanceOf(operator.address);
            if (rplBal < need) {
                console.log(
                    `  - Need ${ethers.formatEther(need)} more RPL; ${operator.address} has ${ethers.formatEther(rplBal)}; funding from guardian...`,
                );
                await fundOperatorRpl(provider, deployment, operator, need - rplBal);
                rplBal = await rpl.balanceOf(operator.address);
                if (rplBal < need) {
                    throw new Error(
                        `Need ${ethers.formatEther(need)} more RPL to stake but ${operator.address} still has ${ethers.formatEther(rplBal)} after funding`,
                    );
                }
            }
            const allowance = await rpl.allowance(operator.address, stakingAddr);
            if (allowance < need) {
                const opts = await gasOverrides(rpl, 'approve', [stakingAddr, need], operator);
                console.log(`  - approve NodeStaking ${ethers.formatEther(need)} RPL...`);
                const tx = await rpl.approve(stakingAddr, need, opts);
                await tx.wait();
                console.log(`    ok ${tx.hash}`);
            }
            const opts = await gasOverrides(staking, 'stakeRPL', [need], operator);
            console.log(`  - stakeRPL(${ethers.formatEther(need)}) gasLimit=${opts.gasLimit}...`);
            const tx = await staking.stakeRPL(need, opts);
            const receipt = await tx.wait();
            if (receipt.status !== 1) {
                throw new Error(`stakeRPL failed status=${receipt.status} tx=${tx.hash}`);
            }
            const after = await staking.getNodeStakedRPL(operator.address);
            console.log(`    ok ${tx.hash} (staked now ${ethers.formatEther(after)} RPL)`);
        }
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
