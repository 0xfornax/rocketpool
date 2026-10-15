const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planRplFunding, ensureGuardianRpl } = require('./rpl-funding');

const defaults = {
    guardian: 'guardian', balances: {}, members: ['alice', 'bob', 'carol'], bond: 1750n,
    seedAddress: 'alice', seedAmount: 10000n, rewardsAmount: 1000n,
    operator: 'alice', stakeAmount: 2000n,
};

test('fresh deployment reserves three bonds plus operator and rewards in one swap', () => {
    assert.equal(planRplFunding(defaults).swapAmount, 16250n);
});

test('existing recipient and guardian balances reduce the swap', () => {
    assert.equal(planRplFunding({ ...defaults,
        balances: { guardian: 2000n, alice: 500n, bob: 1750n, carol: 2500n },
    }).swapAmount, 10250n);
});

test('deduplicates members and handles guardian as bond recipient', () => {
    assert.equal(planRplFunding({ ...defaults, members: ['guardian', 'ALICE', 'alice'],
        balances: { guardian: 1000n },
    }).swapAmount, 13500n);
});

test('accounts for a separate operator or a stake exceeding the seed', () => {
    assert.equal(planRplFunding({ ...defaults, operator: 'dave' }).swapAmount, 18250n);
    assert.equal(planRplFunding({ ...defaults, stakeAmount: 12000n }).swapAmount, 18250n);
});

test('skip combinations require only the remaining operations', () => {
    assert.equal(planRplFunding({ guardian: 'guardian', balances: {} }).swapAmount, 0n);
    assert.equal(planRplFunding({ ...defaults, members: [], stakeAmount: 0n }).swapAmount, 11000n);
    assert.equal(planRplFunding({ ...defaults, seedAmount: 0n, rewardsAmount: 0n }).swapAmount, 7250n);
});

test('guardian as seed/operator does not require self-transfers', () => {
    assert.equal(planRplFunding({ ...defaults, members: [], seedAddress: 'guardian',
        operator: 'guardian', balances: { guardian: 500n },
    }).swapAmount, 2500n);
});

function tokens({ rplBalance = 0n, dummyBalance = 20000n, allowance = 0n, failSwap = false } = {}) {
    const calls = [];
    const method = (name, effect) => Object.assign(async (...args) => {
        calls.push([name, ...args.slice(0, -1)]);
        if (name !== 'swap' || !failSwap) effect(...args);
        return { hash: name, wait: async () => ({ status: name === 'swap' && failSwap ? 0 : 1 }) };
    }, { estimateGas: async () => 100000n });
    const rpl = {
        balanceOf: async () => rplBalance,
        getAddress: async () => 'rpl',
        swapTokens: method('swap', amount => {
            assert.ok(dummyBalance >= amount && allowance >= amount);
            dummyBalance -= amount;
            allowance -= amount;
            rplBalance += amount;
        }),
    };
    const dummyRpl = {
        balanceOf: async () => dummyBalance,
        allowance: async () => allowance,
        mint: method('mint', (_, amount) => { dummyBalance += amount; }),
        approve: method('approve', (_, amount) => { allowance = amount; }),
    };
    return { guardian: { address: 'guardian' }, rpl, dummyRpl, calls,
        spend: amount => { assert.ok(rplBalance >= amount); rplBalance -= amount; } };
}

test('one approval and swap supply all subsequent funding stages', async () => {
    const t = tokens();
    await ensureGuardianRpl({ ...t, amount: planRplFunding(defaults).requiredGuardianBalance });
    for (const amount of [1750n, 1750n, 1750n, 11000n]) {
        await ensureGuardianRpl({ ...t, amount });
        t.spend(amount);
    }
    assert.deepEqual(t.calls, [['approve', 'rpl', 16250n], ['swap', 16250n]]);
    assert.equal(await t.rpl.balanceOf(), 0n);
});

test('uses existing RPL and allowance; mints only the DRPL deficit', async () => {
    const t = tokens({ rplBalance: 200n, dummyBalance: 100n, allowance: 1000n });
    await ensureGuardianRpl({ ...t, amount: 1000n });
    assert.deepEqual(t.calls, [['mint', 'guardian', 700n], ['swap', 800n]]);
});

test('no transactions for a funded guardian or a zero requirement', async () => {
    const t = tokens({ rplBalance: 1000n });
    await ensureGuardianRpl({ ...t, amount: 1000n });
    await ensureGuardianRpl({ ...t, amount: 0n });
    assert.deepEqual(t.calls, []);
});

test('failed swap stops funding', async () => {
    await assert.rejects(ensureGuardianRpl({ ...tokens({ failSwap: true }), amount: 1000n }), /swapTokens failed/);
});

test('prepared mode refuses an unexpected second swap', async () => {
    const previous = process.env.RPL_FUNDING_PREPARED;
    process.env.RPL_FUNDING_PREPARED = '1';
    try {
        const t = tokens();
        await assert.rejects(ensureGuardianRpl({ ...t, amount: 1n }), /Prepared guardian RPL balance is insufficient/);
        assert.deepEqual(t.calls, []);
    } finally {
        if (previous === undefined) delete process.env.RPL_FUNDING_PREPARED;
        else process.env.RPL_FUNDING_PREPARED = previous;
    }
});
