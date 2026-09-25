/**
 * Write a plataberget networks-extra.yml overlay from a deployment JSON.
 *
 * Usage:
 *   node scripts/devnet-7/write-plataberget-networks-extra.js \
 *     [deployments/plataberget.json] [out.yml ...]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const DEPLOYMENT_FILE = process.argv[2]
    || process.env.DEPLOYMENT_FILE
    || path.join(ROOT, 'deployments', 'plataberget.json');
const TEMPLATE = process.env.NETWORKS_EXTRA_TEMPLATE
    || '/srv/rocketpool5/networks-extra.yml';

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
    const d = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8'));
    return {
        storage: must(d, 'RocketStorage'),
        rocketSignerRegistry: helper(d, 'RocketSignerRegistry'),
        rplToken: must(d, 'RocketTokenRPL'),
        reth: must(d, 'RocketTokenRETH'),
        rplTwapPool: helper(d, 'UniswapOracleMock', 'RplTwapPool', 'RPLTwapPool'),
        multicall: helper(d, 'Multicall2', 'Multicall'),
        balancebatcher: helper(d, 'EthBalanceChecker'),
    };
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

function main() {
    const addrs = loadAddresses();
    let src = fs.existsSync(TEMPLATE)
        ? fs.readFileSync(TEMPLATE, 'utf8')
        : [
            '# Platåberget (Glamsterdam / Gloas public testnet).',
            'version: 1',
            'networks:',
            '  - name: plataberget',
            '    label: Platåberget',
            '    chainID: 7091047534',
            '    beaconNetwork: plataberget',
            '    customChainConfigDir: plataberget',
            '    isProduction: false',
            '',
        ].join('\n');

    if (/\n    addresses:\n/.test(src)) {
        src = src.replace(/\n    addresses:\n(?:      .*\n?)*/, `\n${formatAddresses(addrs)}\n`);
    } else {
        if (!src.endsWith('\n')) src += '\n';
        src += formatAddresses(addrs) + '\n';
    }

    // Drop the "no Rocket Pool contracts" blurb once addresses exist.
    src = src.replace(
        /There are no Rocket Pool contracts on this network; use it to run execution and consensus clients\.\n/,
        'Rocket Pool v1.4.1-dev contracts deployed against the local synced EL.\n',
    );
    src = src.replace(
        /# No Rocket Pool contracts — clients can sync this chain without an RP deployment\.\n/,
        '# Addresses filled by scripts/devnet-7/write-plataberget-networks-extra.js\n',
    );

    const dests = process.argv.slice(3);
    if (!dests.length) {
        dests.push(path.join(ROOT, 'deployments', 'networks-extra-plataberget.yml'));
    }
    for (const p of dests) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, src);
        console.log(`wrote ${p}`);
    }
    console.log('Platåberget Smart Node addresses:');
    for (const [k, v] of Object.entries(addrs)) {
        console.log(`  ${k}: ${v || '(missing)'}`);
    }
}

main();
