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

function main() {
    const args = parseArgs(process.argv);
    if (!args.settings) throw new Error('--settings required');
    if (!fs.existsSync(args.settings)) throw new Error(`missing ${args.settings}`);

    const env = loadEnvFile(args.env);
    const elHttp = env.EL_HTTP || process.env.EL_HTTP || '';
    const elWs = env.EL_WS || process.env.EL_WS || '';
    const clHttp = env.CL_HTTP || process.env.CL_HTTP || '';
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
}

main();
