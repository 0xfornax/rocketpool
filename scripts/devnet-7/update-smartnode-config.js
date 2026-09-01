/**
 * Patch Smart Node network YAML from deployments/latest.json for Kurtosis.
 *
 * Smart Node reads Storage / RPL / rETH / helpers from networks-default.yml
 * (embed, then on-disk next to user-settings.yml) overlaid by networks-extra.yml.
 * It does not read ROCKETPOOL_DEVNET_* env vars.
 *
 * This script:
 *   1. Patches the `devnet` addresses block in networks-default.yml copies
 *   2. Writes a complete `devnet` networks-extra.yml overlay next to native SN trees
 *
 * Usage:
 *   node scripts/devnet-7/update-smartnode-config.js
 *   DEPLOYMENT_FILE=... SMARTNODE_NETWORKS=... node scripts/devnet-7/update-smartnode-config.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const DEPLOYMENT_FILE = process.env.DEPLOYMENT_FILE
    || path.join(ROOT, 'deployments', 'latest.json');
const CHAIN_ID = Number(process.env.CHAIN_ID || '3151908');

const DEFAULT_NETWORKS = process.env.SMARTNODE_NETWORKS
    || path.join(ROOT, '..', 'smartnode', 'shared/services/rocketpool/assets/install/networks-default.yml');

function must(d, key) {
    const v = d.addresses && d.addresses[key];
    if (!v) throw new Error(`missing addresses.${key} in ${DEPLOYMENT_FILE}`);
    return v;
}

function helper(d, ...keys) {
    for (const k of keys) {
        const v = d.addresses && d.addresses[k];
        if (v) return v;
    }
    return '';
}

function loadAddresses() {
    if (!fs.existsSync(DEPLOYMENT_FILE)) {
        throw new Error(`missing ${DEPLOYMENT_FILE}`);
    }
    const d = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8'));
    const addrs = {
        storage: must(d, 'RocketStorage'),
        rocketSignerRegistry: helper(d, 'RocketSignerRegistry'),
        rplToken: must(d, 'RocketTokenRPL'),
        reth: must(d, 'RocketTokenRETH'),
        rplTwapPool: helper(d, 'UniswapOracleMock', 'RplTwapPool', 'RPLTwapPool'),
        multicall: helper(d, 'Multicall2', 'Multicall'),
        balancebatcher: helper(d, 'EthBalanceChecker'),
    };
    const missingHelpers = Object.entries(addrs)
        .filter(([k, v]) => !v && k !== 'storage' && k !== 'rplToken' && k !== 'reth')
        .map(([k]) => k);
    if (missingHelpers.length) {
        console.warn(`  warning: helper address(es) not in latest.json: ${missingHelpers.join(', ')}`);
        console.warn('           run scripts/devnet-7/deploy-helpers.js first');
    }
    return addrs;
}

function formatAddresses(addrs) {
    const lines = ['    addresses:'];
    const order = [
        'storage',
        'rocketSignerRegistry',
        'rplToken',
        'reth',
        'rplTwapPool',
        'multicall',
        'balancebatcher',
    ];
    for (const key of order) {
        if (addrs[key]) lines.push(`      ${key}: "${addrs[key]}"`);
    }
    return lines.join('\n');
}

function findDevnetRange(src) {
    const re = /^  - name: devnet\s*$/m;
    const m = re.exec(src);
    if (!m) return null;
    const start = m.index;
    const after = src.slice(start + m[0].length);
    const next = after.search(/\n  - name: /);
    const end = next === -1 ? src.length : start + m[0].length + next;
    return { start, end, block: src.slice(start, end) };
}

function patchDevnetAddresses(src, addrs) {
    const range = findDevnetRange(src);
    if (!range) throw new Error('devnet network not found');
    const addrRe = /\n    addresses:\n(?:      .*\n?)*/;
    if (!addrRe.test(range.block)) {
        throw new Error('devnet addresses block not found');
    }
    const patchedBlock = range.block.replace(addrRe, `\n${formatAddresses(addrs)}\n`);
    return src.slice(0, range.start) + patchedBlock + src.slice(range.end);
}

function extraYamlFromDefault(defaultSrc, addrs, chainId) {
    const range = defaultSrc ? findDevnetRange(defaultSrc) : null;
    let block;
    if (range) {
        block = range.block.replace(
            /\n    addresses:\n(?:      .*\n?)*/,
            `\n${formatAddresses(addrs)}\n`,
        );
        block = block.replace(/^    chainID:\s*\d+/m, `    chainID: ${chainId}`);
    } else {
        block = [
            '  - name: devnet',
            '    label: Devnet',
            '    description: Rocket Pool development network. This is a local network that is used for development and testing. It uses free fake ETH and free fake RPL to make fake validators.',
            `    chainID: ${chainId}`,
            '    snapshotApiDomain: hub.snapshot.org',
            '    beaconNetwork: hoodi',
            '    commitBoostChainName: Hoodi',
            '    clientTagSet: test',
            '    customChainConfigDir: devnet',
            '    supportsMevBoost: false',
            '    allowNonBlsWithdrawalCredentials: true',
            '    isProduction: false',
            '    nethermindPruneThresholdMb: 51200',
            '    rewards:',
            '      rulesetStartIntervals:',
            '        - version: 11',
            '          startInterval: 0',
            '        - version: 10',
            '          startInterval: 0',
            formatAddresses(addrs),
        ].join('\n') + '\n';
    }
    if (!block.endsWith('\n')) block += '\n';
    return (
        '# Generated by scripts/devnet-7/update-smartnode-config.js for Kurtosis.\n'
        + '# Same-name `devnet` replaces the official networks-default.yml entry.\n'
        + '# Place this next to user-settings.yml (LoadFromFile uses that directory).\n'
        + 'version: 1\n'
        + 'networks:\n'
        + block
    );
}

function writeFile(p, content) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
}

function extraDests() {
    const extra = [];
    extra.push(path.join(ROOT, 'deployments', 'networks-extra.yml'));
    const envDirs = (process.env.SMARTNODE_EXTRA_DIRS || '')
        .split(path.delimiter)
        .map((s) => s.trim())
        .filter(Boolean);
    const defaults = [
        '/srv/rocketpool3',
        '/srv/rocketpool3/rocketpool',
        '/srv/rocketpool4',
        '/srv/rocketpool4/rocketpool',
        path.join(os.homedir(), '.rocketpool'),
    ];
    for (const dir of [...defaults, ...envDirs]) {
        extra.push(path.join(dir, 'networks-extra.yml'));
    }
    return extra;
}

function defaultYamls() {
    const out = [];
    if (process.env.SMARTNODE_NETWORKS) out.push(process.env.SMARTNODE_NETWORKS);
    else if (fs.existsSync(DEFAULT_NETWORKS)) out.push(DEFAULT_NETWORKS);
    const homeDefault = path.join(os.homedir(), '.rocketpool', 'networks-default.yml');
    if (fs.existsSync(homeDefault) && !out.includes(homeDefault)) out.push(homeDefault);
    return out;
}

function main() {
    const addrs = loadAddresses();
    const defaults = defaultYamls();
    let templateSrc = '';
    if (defaults.length) templateSrc = fs.readFileSync(defaults[0], 'utf8');

    console.log('Updated Smart Node Kurtosis Devnet addresses:');
    console.log(`  chainId:  ${CHAIN_ID}`);
    console.log(`  storage:  ${addrs.storage}`);
    console.log(`  rpl:      ${addrs.rplToken}`);
    console.log(`  reth:     ${addrs.reth}`);
    console.log(`  multicall:${addrs.multicall || '(missing)'}`);
    console.log(`  batcher:  ${addrs.balancebatcher || '(missing)'}`);
    console.log(`  signer:   ${addrs.rocketSignerRegistry || '(missing)'}`);
    console.log(`  twap:     ${addrs.rplTwapPool || '(missing)'}`);

    for (const p of defaults) {
        const src = fs.readFileSync(p, 'utf8');
        const patched = patchDevnetAddresses(src, addrs);
        writeFile(p, patched);
        console.log(`  patched:  ${p}`);
        if (!templateSrc) templateSrc = patched;
    }

    const extra = extraYamlFromDefault(templateSrc, addrs, CHAIN_ID);
    for (const p of extraDests()) {
        const dir = path.dirname(p);
        if (dir !== path.join(ROOT, 'deployments') && !fs.existsSync(dir)) {
            continue;
        }
        writeFile(p, extra);
        console.log(`  extra:    ${p}`);
    }
}

main();
