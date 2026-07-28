/**
 * Register the /srv/rocketpool3 Smart Node wallet as a Rocket Pool node.
 *
 * Decrypts the Rocket Pool v4 keystore (encrypted BIP39 seed → m/44'/60'/0'/0/0),
 * then calls RocketNodeManager.registerNode if not already registered.
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
 *   DEPLOYMENT_FILE  deployments/latest.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '../..');
const DEPLOYMENT_FILE = process.env.DEPLOYMENT_FILE
    || path.join(ROOT, 'deployments', 'latest.json');
const RP_DIR = process.env.RP_DIR || '/srv/rocketpool3';
const TIMEZONE = process.env.TIMEZONE || process.env.ODAO_TIMEZONE || 'Australia/Brisbane';
const TX_GAS_CAP = BigInt(process.env.TX_GAS_CAP || '16000000');

const NODE_MANAGER_ABI = [
    'function registerNode(string timezoneLocation)',
    'function getNodeExists(address nodeAddress) view returns (bool)',
    'function getNodeTimezoneLocation(address nodeAddress) view returns (string)',
];

function loadDeployment() {
    if (!fs.existsSync(DEPLOYMENT_FILE)) {
        throw new Error(`Missing deployment file: ${DEPLOYMENT_FILE}`);
    }
    return JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8'));
}

/**
 * Decrypt Rocket Pool CLI wallet v4 keystore (encrypted 64-byte BIP39 seed).
 * Returns ethers HDNodeWallet for account 0 (m/44'/60'/0'/0/0).
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
    const accountPath = pathTpl.includes('%d') ? pathTpl.replace('%d', '0') : "m/44'/60'/0'/0/0";
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
    console.log(`  Wallet:      ${wallet.address}`);
    console.log(`  NodeManager: ${nodeManagerAddr}`);
    console.log(`  Timezone:    ${TIMEZONE}`);

    const nodeManager = new ethers.Contract(nodeManagerAddr, NODE_MANAGER_ABI, provider);
    if (await nodeManager.getNodeExists(wallet.address)) {
        const tz = await nodeManager.getNodeTimezoneLocation(wallet.address);
        console.log(`  Already registered (timezone=${tz}); nothing to do`);
        return;
    }

    const bal = await provider.getBalance(wallet.address);
    console.log(`  ETH balance: ${ethers.formatEther(bal)}`);
    if (bal === 0n) {
        throw new Error(
            `Wallet ${wallet.address} has 0 ETH — run seed-devnet.js first (SEED_ADDRESS should match wallet)`,
        );
    }

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

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
