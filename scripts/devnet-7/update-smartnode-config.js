/**
 * Patch smartnode shared/services/config/smartnode-config.go Kurtosis Devnet
 * hardcoded addresses from deployments/latest.json (+ helpers if present).
 *
 * Usage:
 *   node scripts/devnet-7/update-smartnode-config.js
 *   DEPLOYMENT_FILE=... SMARTNODE_CONFIG=... node scripts/devnet-7/update-smartnode-config.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const DEPLOYMENT_FILE = process.env.DEPLOYMENT_FILE
    || path.join(ROOT, 'deployments', 'latest.json');
const SMARTNODE_CONFIG = process.env.SMARTNODE_CONFIG
    || path.join(ROOT, '..', 'smartnode', 'shared', 'services', 'config', 'smartnode-config.go');
const CHAIN_ID = process.env.CHAIN_ID || '3151908';

function must(d, key) {
    const v = d.addresses && d.addresses[key];
    if (!v) throw new Error(`missing addresses.${key} in ${DEPLOYMENT_FILE}`);
    return v;
}

function replaceConst(src, name, value) {
    // kurtosisDevnetXxxDefault ... = "0x..." or uint = N
    const reStr = new RegExp(
        `(${name}\\s+string\\s*=\\s*)"[^"]*"`,
        'm',
    );
    const reUint = new RegExp(
        `(${name}\\s+uint\\s*=\\s*)\\d+`,
        'm',
    );
    if (reStr.test(src)) {
        return src.replace(reStr, `$1"${value}"`);
    }
    if (reUint.test(src)) {
        return src.replace(reUint, `$1${value}`);
    }
    throw new Error(`constant ${name} not found in ${SMARTNODE_CONFIG}`);
}

function main() {
    if (!fs.existsSync(DEPLOYMENT_FILE)) {
        throw new Error(`missing ${DEPLOYMENT_FILE}`);
    }
    if (!fs.existsSync(SMARTNODE_CONFIG)) {
        throw new Error(`missing ${SMARTNODE_CONFIG} (set SMARTNODE_CONFIG=...)`);
    }

    const d = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8'));
    const storage = must(d, 'RocketStorage');
    const rpl = must(d, 'RocketTokenRPL');
    const reth = must(d, 'RocketTokenRETH');
    const multicall = d.addresses.Multicall2 || d.addresses.Multicall || '';
    const batcher = d.addresses.EthBalanceChecker || '';
    const signer = d.addresses.RocketSignerRegistry || '';
    const twap = d.addresses.UniswapOracleMock
        || d.addresses.RplTwapPool
        || d.addresses.RPLTwapPool
        || '';

    let src = fs.readFileSync(SMARTNODE_CONFIG, 'utf8');
    src = replaceConst(src, 'kurtosisDevnetChainIDDefault', CHAIN_ID);
    src = replaceConst(src, 'kurtosisDevnetStorageAddressDefault', storage);
    src = replaceConst(src, 'kurtosisDevnetRplAddressDefault', rpl);
    src = replaceConst(src, 'kurtosisDevnetRethAddressDefault', reth);
    if (multicall) {
        src = replaceConst(src, 'kurtosisDevnetMulticallAddressDefault', multicall);
    }
    if (batcher) {
        src = replaceConst(src, 'kurtosisDevnetBalanceBatcherAddressDefault', batcher);
    }
    if (signer) {
        src = replaceConst(src, 'kurtosisDevnetSignerRegistryAddressDefault', signer);
    }
    if (twap) {
        // Optional const — added when Smart Node has kurtosisDevnetRplTwapPoolAddressDefault
        try {
            src = replaceConst(src, 'kurtosisDevnetRplTwapPoolAddressDefault', twap);
        } catch (e) {
            // Fall back: patch the Network_Devnet entry in rplTwapPoolAddress map
            const reMap = /(config\.Network_Devnet:\s*)"[^"]*"(\s*,\s*\n\s*config\.Network_Testnet:.*\n\s*\},?\s*\n\s*multicallAddress)/m;
            // Prefer a tighter match on the rplTwapPoolAddress block only
            const reTwap = /(rplTwapPoolAddress:\s*map\[config\.Network\]string\{[\s\S]*?config\.Network_Devnet:\s*)"[^"]*"/;
            if (reTwap.test(src)) {
                src = src.replace(reTwap, `$1"${twap}"`);
            } else if (reMap.test(src)) {
                src = src.replace(reMap, `$1"${twap}"$2`);
            } else {
                throw new Error(
                    `could not set TWAP address in ${SMARTNODE_CONFIG}: ${e.message}`,
                );
            }
        }
    }

    fs.writeFileSync(SMARTNODE_CONFIG, src, 'utf8');
    console.log('Updated Smart Node Kurtosis Devnet defaults:');
    console.log(`  file:     ${SMARTNODE_CONFIG}`);
    console.log(`  chainId:  ${CHAIN_ID}`);
    console.log(`  storage:  ${storage}`);
    console.log(`  rpl:      ${rpl}`);
    console.log(`  reth:     ${reth}`);
    console.log(`  multicall:${multicall || '(unchanged)'}`);
    console.log(`  batcher:  ${batcher || '(unchanged)'}`);
    console.log(`  signer:   ${signer || '(unchanged)'}`);
    console.log(`  twap:     ${twap || '(unchanged)'}`);
}

main();
