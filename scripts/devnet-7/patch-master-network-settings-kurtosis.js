/**
 * Kurtosis-only patches for protocol settings in the baseline worktree.
 *
 * Network (RocketDAOProtocolSettingsNetwork.sol):
 *   - Default prices/balances submit frequency: 1 day → 300s
 *   - Guardrail min for balances.frequency: 1 hour → 300s
 *
 * Rewards (RocketDAOProtocolSettingsRewards.sol, optional 2nd arg or sibling path):
 *   - Default rewards.claims periods: 28 → 4
 *     (interval time = periods × balances.frequency = 4 × 300s = 20 minutes)
 *
 * Proposals (RocketDAOProtocolSettingsProposals.sol, sibling of Network):
 *   - Default vote phase1/phase2: 1 week → 15 minutes
 *   - Guardrail min for vote phase times: 1 day → 15 minutes
 *
 * Security (RocketDAOProtocolSettingsSecurity.sol, sibling of Network):
 *   - Default upgrade.delay: 7 days → 10 minutes
 *   - Guardrail min for upgrade.delay: 1 day → 10 minutes
 *
 * Usage:
 *   node scripts/devnet-7/patch-master-network-settings-kurtosis.js \
 *     /path/to/worktree/contracts/contract/dao/protocol/settings/RocketDAOProtocolSettingsNetwork.sol \
 *     [/path/to/worktree/.../RocketDAOProtocolSettingsRewards.sol]
 */
const fs = require('fs');
const path = require('path');

const networkTarget = process.argv[2];
if (!networkTarget || !fs.existsSync(networkTarget)) {
    console.error(
        'Usage: node patch-master-network-settings-kurtosis.js <SettingsNetwork.sol> [SettingsRewards.sol]',
    );
    process.exit(1);
}

let rewardsTarget = process.argv[3];
if (!rewardsTarget) {
    // Same settings directory as Network
    const sibling = path.join(path.dirname(networkTarget), 'RocketDAOProtocolSettingsRewards.sol');
    if (fs.existsSync(sibling)) rewardsTarget = sibling;
}

function patchNetwork(file) {
    let src = fs.readFileSync(file, 'utf8');
    let n = 0;

    const reBal = /_setSettingUint\(\s*"network\.submit\.balances\.frequency"\s*,\s*1 days\s*\)/;
    const rePri = /_setSettingUint\(\s*"network\.submit\.prices\.frequency"\s*,\s*1 days\s*\)/;
    if (reBal.test(src)) {
        src = src.replace(reBal, '_setSettingUint("network.submit.balances.frequency", 300)');
        n++;
        console.log('  Network defaults: balances.frequency → 300s');
    }
    if (rePri.test(src)) {
        src = src.replace(rePri, '_setSettingUint("network.submit.prices.frequency", 300)');
        n++;
        console.log('  Network defaults: prices.frequency → 300s');
    }

    const reGuard = /require\(\s*_value\s*>=\s*1 hours\s*&&\s*_value\s*<=\s*7 days\s*,\s*"Value must be >= 1 hour & <= 7 days"\s*\)/;
    if (reGuard.test(src)) {
        src = src.replace(
            reGuard,
            'require(_value >= 300 && _value <= 7 days, "Value must be >= 300 seconds & <= 7 days")',
        );
        n++;
        console.log('  Network guardrail: balances.frequency min → 300s');
    }

    if (n === 0) {
        if (src.includes('network.submit.balances.frequency", 300')) {
            console.log(`  Network already Kurtosis-patched: ${file}`);
            return;
        }
        console.error(`No Network frequency patterns matched in ${file}`);
        process.exit(1);
    }
    fs.writeFileSync(file, src);
    console.log(`  Wrote ${file} (${n} change(s))`);
}

function patchRewards(file) {
    let src = fs.readFileSync(file, 'utf8');
    // constructor: setUint(..., "rewards.claims", "periods"), 28)
    const re = /setUint\(\s*keccak256\(\s*abi\.encodePacked\(\s*settingNameSpace\s*,\s*"rewards\.claims"\s*,\s*"periods"\s*\)\s*\)\s*,\s*28\s*\)/;
    if (re.test(src)) {
        src = src.replace(
            re,
            'setUint(keccak256(abi.encodePacked(settingNameSpace, "rewards.claims", "periods")), 4)',
        );
        fs.writeFileSync(file, src);
        console.log('  Rewards defaults: claims periods 28 → 4 (×300s = 20 min interval)');
        console.log(`  Wrote ${file}`);
        return;
    }
    // Accept prior Kurtosis patches (2/6) or current default (4 → 20 min).
    if (src.includes('"rewards.claims", "periods")), 4)')
        || src.includes('"rewards.claims", "periods"), 4)')
        || src.includes('"rewards.claims", "periods")), 6)')
        || src.includes('"rewards.claims", "periods"), 6)')
        || src.includes('"rewards.claims", "periods")), 2)')
        || src.includes('"rewards.claims", "periods"), 2)')) {
        console.log(`  Rewards already Kurtosis-patched: ${file}`);
        return;
    }
    console.error(`No Rewards periods default matched in ${file}`);
    process.exit(1);
}

function patchProposals(file) {
    let src = fs.readFileSync(file, 'utf8');
    let n = 0;
    const reP1 = /setSettingUint\(\s*"proposal\.vote\.phase1\.time"\s*,\s*1 weeks\s*\)/;
    const reP2 = /setSettingUint\(\s*"proposal\.vote\.phase2\.time"\s*,\s*1 weeks\s*\)/;
    const reDelay = /setSettingUint\(\s*"proposal\.vote\.delay\.time"\s*,\s*1 weeks\s*\)/;
    if (reP1.test(src)) {
        src = src.replace(reP1, 'setSettingUint("proposal.vote.phase1.time", 15 minutes)');
        n++;
        console.log('  Proposals default: vote.phase1.time → 15 minutes');
    }
    if (reP2.test(src)) {
        src = src.replace(reP2, 'setSettingUint("proposal.vote.phase2.time", 15 minutes)');
        n++;
        console.log('  Proposals default: vote.phase2.time → 15 minutes');
    }
    if (reDelay.test(src)) {
        src = src.replace(reDelay, 'setSettingUint("proposal.vote.delay.time", 5 minutes)');
        n++;
        console.log('  Proposals default: vote.delay.time → 5 minutes');
    }
    const reGuard = /if\s*\(\s*settingKey\s*==\s*keccak256\(\s*bytes\(\s*"proposal\.vote\.phase1\.time"\s*\)\s*\)\s*\)\s*\{[\s\S]*?require\(\s*_value\s*>=\s*1 days\s*,\s*"Value must be at least 1 day"\s*\);\s*\} else if\s*\(\s*settingKey\s*==\s*keccak256\(\s*bytes\(\s*"proposal\.vote\.phase2\.time"\s*\)\s*\)\s*\)\s*\{[\s\S]*?require\(\s*_value\s*>=\s*1 days\s*,\s*"Value must be at least 1 day"\s*\);/;
    if (reGuard.test(src)) {
        src = src.replace(
            reGuard,
            'if(settingKey == keccak256(bytes("proposal.vote.phase1.time"))) {\n'
            + '            require(_value >= 15 minutes, "Value must be at least 15 minutes");\n'
            + '        } else if(settingKey == keccak256(bytes("proposal.vote.phase2.time"))) {\n'
            + '            require(_value >= 15 minutes, "Value must be at least 15 minutes");',
        );
        n++;
        console.log('  Proposals guardrail: vote phase min 1 day → 15 minutes');
    }
    const reDelayGuard = /if\s*\(\s*settingKey\s*==\s*keccak256\(\s*bytes\(\s*"proposal\.vote\.delay\.time"\s*\)\s*\)\s*\)\s*\{[\s\S]*?require\(\s*_value\s*>=\s*1 weeks\s*,\s*"Value must be at least 1 week"\s*\);/;
    if (reDelayGuard.test(src)) {
        src = src.replace(
            reDelayGuard,
            'if(settingKey == keccak256(bytes("proposal.vote.delay.time"))) {\n'
            + '            require(_value >= 5 minutes, "Value must be at least 5 minutes");',
        );
        n++;
        console.log('  Proposals guardrail: vote delay min 1 week → 5 minutes');
    }
    if (n === 0) {
        if (src.includes('proposal.vote.phase1.time", 15 minutes')
            || src.includes('proposal.vote.delay.time", 5 minutes')) {
            console.log(`  Proposals already Kurtosis-patched: ${file}`);
            return;
        }
        console.error(`No Proposals vote-phase patterns matched in ${file}`);
        process.exit(1);
    }
    fs.writeFileSync(file, src);
    console.log(`  Wrote ${file} (${n} change(s))`);
}

function patchSecurity(file) {
    let src = fs.readFileSync(file, 'utf8');
    let n = 0;
    const reDefault = /_setSettingUint\(\s*"upgrade\.delay"\s*,\s*7 days\s*\)/;
    if (reDefault.test(src)) {
        src = src.replace(reDefault, '_setSettingUint("upgrade.delay", 10 minutes)');
        n++;
        console.log('  Security default: upgrade.delay → 10 minutes');
    }
    const reGuard = /require\(\s*_value\s*>=\s*1 days\s*&&\s*_value\s*<=\s*30 days\s*,\s*"Value must be >= 1 day & <= 30 days"\s*\)/;
    if (reGuard.test(src)) {
        src = src.replace(
            reGuard,
            'require(_value >= 10 minutes && _value <= 30 days, "Value must be >= 10 minutes & <= 30 days")',
        );
        n++;
        console.log('  Security guardrail: upgrade.delay min 1 day → 10 minutes');
    }
    if (n === 0) {
        if (src.includes('upgrade.delay", 10 minutes')) {
            console.log(`  Security already Kurtosis-patched: ${file}`);
            return;
        }
        console.error(`No Security upgrade.delay patterns matched in ${file}`);
        process.exit(1);
    }
    fs.writeFileSync(file, src);
    console.log(`  Wrote ${file} (${n} change(s))`);
}

console.log('Kurtosis protocol settings patch:');
patchNetwork(networkTarget);
if (rewardsTarget) {
    patchRewards(rewardsTarget);
} else {
    console.log('  (no SettingsRewards.sol path; skip periods default)');
}
const proposalsTarget = path.join(path.dirname(networkTarget), 'RocketDAOProtocolSettingsProposals.sol');
if (fs.existsSync(proposalsTarget)) {
    patchProposals(proposalsTarget);
} else {
    console.log('  (no SettingsProposals.sol path; skip vote-phase defaults)');
}
const securityTarget = path.join(path.dirname(networkTarget), 'RocketDAOProtocolSettingsSecurity.sol');
if (fs.existsSync(securityTarget)) {
    patchSecurity(securityTarget);
} else {
    console.log('  (no SettingsSecurity.sol path; skip upgrade.delay defaults)');
}
