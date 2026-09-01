/**
 * Patch a Smart Node user-settings.yml for Kurtosis native mode.
 *
 * Usage:
 *   node scripts/devnet-7/patch-native-settings.js \
 *     --settings /srv/rocketpool3/user-settings.yml \
 *     --env deployments/odao-smartnode.env \
 *     --rp-dir /srv/rocketpool3
 */
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
    const out = { settings: '', env: '', rpDir: '/srv/rocketpool3' };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--settings') out.settings = argv[++i];
        else if (argv[i] === '--env') out.env = argv[++i];
        else if (argv[i] === '--rp-dir') out.rpDir = argv[++i];
    }
    return out;
}

function loadEnvFile(p) {
    const env = {};
    if (!p || !fs.existsSync(p)) return env;
    for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return env;
}

/**
 * Minimal YAML field updater for Smart Node user-settings style files
 * (flat "key: value" under known top-level sections). Does not re-serialize
 * the whole document so unrelated formatting is preserved.
 */
function setSectionField(text, section, field, value) {
    const lines = text.split('\n');
    let inSection = false;
    let sectionIndent = 0;
    let fieldLine = -1;
    let insertAt = -1;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = line.match(/^([ \t]*)([^:\s][^:]*):\s*(.*)$/);
        if (!m) continue;
        const indent = m[1].length;
        const key = m[2];

        if (indent === 0) {
            if (inSection) {
                // left the section
                if (fieldLine < 0 && insertAt < 0) insertAt = i;
                break;
            }
            if (key === section) {
                inSection = true;
                sectionIndent = 0;
                continue;
            }
        }

        if (inSection && indent > sectionIndent) {
            if (key === field) {
                fieldLine = i;
                const prefix = line.slice(0, line.indexOf(':') + 1);
                lines[i] = `${prefix} ${value}`;
                return lines.join('\n');
            }
        }
    }

    if (!inSection) {
        // append section
        if (text.length && !text.endsWith('\n')) text += '\n';
        return text + `${section}:\n  ${field}: ${value}\n`;
    }

    // section exists but field missing — insert after section header
    for (let i = 0; i < lines.length; i++) {
        if (new RegExp(`^${section}:\\s*$`).test(lines[i]) || new RegExp(`^${section}:\\s`).test(lines[i])) {
            lines.splice(i + 1, 0, `  ${field}: ${value}`);
            return lines.join('\n');
        }
    }
    return lines.join('\n');
}

function setRootField(text, field, value) {
    return setSectionField(text, 'root', field, value);
}

function rpc(elHttp, method, params) {
    const { execFileSync } = require('child_process');
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const out = execFileSync('curl', ['-sf', elHttp, '-H', 'Content-Type: application/json', '-d', body], {
        encoding: 'utf8',
        timeout: 15000,
    });
    const parsed = JSON.parse(out);
    if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
    return parsed.result;
}

function fetchGenesisTime(clHttp) {
    try {
        const { execFileSync } = require('child_process');
        const out = execFileSync('curl', ['-sf', `${clHttp}/eth/v1/beacon/genesis`], {
            encoding: 'utf8',
            timeout: 10000,
        });
        const m = out.match(/"genesis_time"\s*:\s*"(\d+)"/);
        if (m) return m[1];
    } catch (e) {
        // fall through
    }
    return null;
}

/**
 * First block where `addr` has code, as a unix timestamp. Watchtower eth_calls
 * Multicall2 at the *target* historical block, so the P/B reference must not
 * land before helpers exist (empty bytecode → ABI unmarshal empty string).
 */
function firstCodeTimestamp(elHttp, addr) {
    if (!elHttp || !addr) return null;
    try {
        const latest = parseInt(rpc(elHttp, 'eth_blockNumber', []), 16);
        let lo = 0;
        let hi = latest;
        let found = null;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const code = rpc(elHttp, 'eth_getCode', [addr, `0x${mid.toString(16)}`]);
            if (code && code !== '0x') {
                found = mid;
                hi = mid - 1;
            } else {
                lo = mid + 1;
            }
        }
        if (found == null) return null;
        const block = rpc(elHttp, 'eth_getBlockByNumber', [`0x${found.toString(16)}`, false]);
        return String(parseInt(block.timestamp, 16));
    } catch (e) {
        return null;
    }
}

/**
 * Resolve a prices/balances submission reference timestamp at/after beacon
 * genesis *and* helper deployment. Stale GENESIS_BLOCK_TIMESTAMP from a
 * previous Kurtosis run (or mainnet 1713420000) makes watchtower target a
 * slot that has no Multicall2 code.
 */
function resolveSubmissionReferenceTimestamp(clHttp, elHttp, env) {
    if (process.env.PRICE_BALANCE_SUBMISSION_REFERENCE_TIMESTAMP) {
        return String(process.env.PRICE_BALANCE_SUBMISSION_REFERENCE_TIMESTAMP);
    }

    const liveGenesis = fetchGenesisTime(clHttp);
    const envGenesis = env.GENESIS_BLOCK_TIMESTAMP && env.GENESIS_BLOCK_TIMESTAMP !== '0'
        ? env.GENESIS_BLOCK_TIMESTAMP
        : (process.env.GENESIS_BLOCK_TIMESTAMP && process.env.GENESIS_BLOCK_TIMESTAMP !== '0'
            ? process.env.GENESIS_BLOCK_TIMESTAMP
            : null);
    // Prefer live CL genesis; env is only a fallback (it goes stale across redeploys).
    let ref = liveGenesis || envGenesis;
    if (!ref) return null;

    const multicall = env.MULTICALL_ADDRESS
        || env.ROCKETPOOL_DEVNET_MULTICALL_ADDRESS
        || process.env.MULTICALL_ADDRESS
        || '';
    const helperTs = firstCodeTimestamp(elHttp, multicall);
    if (helperTs && Number(helperTs) > Number(ref)) {
        ref = helperTs;
    }
    return ref;
}

function main() {
    const args = parseArgs(process.argv);
    if (!args.settings) throw new Error('--settings required');
    if (!fs.existsSync(args.settings)) throw new Error(`missing ${args.settings}`);

    const env = loadEnvFile(args.env);
    // Defaults match scripts/devnet-7/kurtosis-ports.env + network_params.yaml port_publisher.
    const elHttp = env.EL_HTTP || process.env.EL_HTTP || 'http://127.0.0.1:32003';
    const elWs = env.EL_WS || process.env.EL_WS || 'ws://127.0.0.1:32004';
    const clHttp = env.CL_HTTP || process.env.CL_HTTP || 'http://127.0.0.1:33101';
    if (!elHttp || !clHttp) {
        throw new Error('EL_HTTP and CL_HTTP required (via --env or environment)');
    }

    let text = fs.readFileSync(args.settings, 'utf8');
    const rpDir = args.rpDir.replace(/\/$/, '');
    const dataPath = `${rpDir}/data`;

    // root
    text = setRootField(text, 'isNative', '"true"');
    text = setRootField(text, 'rpDir', rpDir);
    text = setRootField(text, 'executionClientMode', 'external');
    text = setRootField(text, 'consensusClientMode', 'external');
    text = setRootField(text, 'externalConsensusClient', 'lighthouse');
    text = setRootField(text, 'consensusClient', 'lighthouse');
    text = setRootField(text, 'enableMevBoost', '"false"');
    text = setRootField(text, 'enableCommitBoost', '"false"');
    text = setRootField(text, 'useFallbackClients', '"false"');
    text = setRootField(text, 'enableODaoMetrics', '"true"');

    // smartnode
    text = setSectionField(text, 'smartnode', 'network', 'devnet');
    text = setSectionField(text, 'smartnode', 'dataPath', dataPath);
    text = setSectionField(text, 'smartnode', 'projectName', path.basename(rpDir));
    text = setSectionField(text, 'smartnode', 'rewardsTreeMode', 'generate');

    // P/B submission schedule must start at/after this chain's genesis (not mainnet 6AM epoch)
    // and not before Multicall2 exists on this deploy.
    const pbRef = resolveSubmissionReferenceTimestamp(clHttp, elHttp, env);
    if (pbRef) {
        text = setSectionField(text, 'smartnode', 'priceBalanceSubmissionReferenceTimestamp', `"${pbRef}"`);
    }

    // Kurtosis geth runs with el_storage_type/archive + --gcmode=archive. Point
    // Smart Node Archive EC at the same URL so watchtower historical eth_calls
    // (balances/prices at past blocks) use an archive-capable endpoint. Empty
    // archiveECUrl makes GetBestApiClient fail hard when primary state is missing.
    text = setSectionField(text, 'smartnode', 'archiveECUrl', elHttp);

    // native mode endpoints (primary for isNative=true)
    text = setSectionField(text, 'native', 'ecHttpUrl', elHttp);
    text = setSectionField(text, 'native', 'ccHttpUrl', clHttp);
    text = setSectionField(text, 'native', 'consensusClient', 'lighthouse');
    text = setSectionField(text, 'native', 'validatorRestartCommand', `${rpDir}/rocketpool/restart-vc.sh`);
    text = setSectionField(text, 'native', 'validatorStopCommand', `${rpDir}/rocketpool/stop-validator.sh`);

    // also keep external-* in sync for hybrid fallbacks / UI
    text = setSectionField(text, 'externalExecution', 'httpUrl', elHttp);
    text = setSectionField(text, 'externalExecution', 'wsUrl', elWs || elHttp.replace(/^http/, 'ws'));
    text = setSectionField(text, 'externalLighthouse', 'httpUrl', clHttp);
    text = setSectionField(text, 'externalLighthouse', 'doppelgangerDetection', '"false"');

    fs.writeFileSync(args.settings, text);
    console.log(`patched ${args.settings}`);
    console.log(`  isNative=true network=devnet`);
    console.log(`  native.ecHttpUrl=${elHttp}`);
    console.log(`  native.ccHttpUrl=${clHttp}`);
    console.log(`  dataPath=${dataPath}`);
    if (pbRef) {
        console.log(`  priceBalanceSubmissionReferenceTimestamp=${pbRef} (chain genesis-aligned)`);
    } else {
        console.log('  warning: could not resolve genesis for priceBalanceSubmissionReferenceTimestamp');
    }
    console.log(`  archiveECUrl=${elHttp} (same as primary; requires Kurtosis geth archive)`);
}

main();
