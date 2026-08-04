// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.30;

/**
    @dev Mock Uniswap V3 pool `observe` for local Kurtosis / Smart Node RPL TWAP.
         Smart Node calls observe([lookbackSeconds, 0]) and requires two tick
         cumulatives. A constant tick of 0 yields rplPrice = 1e18 (1 ETH per RPL)
         in the SN formula — fine for oDAO price submissions on devnets.
*/
contract UniswapOracleMock {
    /// @notice Uniswap V3-compatible observe. Length of outputs matches input.
    function observe(uint32[] calldata secondsAgos)
        external
        pure
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        uint256 n = secondsAgos.length;
        require(n > 0, "empty secondsAgos");
        tickCumulatives = new int56[](n);
        secondsPerLiquidityCumulativeX128s = new uint160[](n);
        // Constant tick = 0: any (cum[i]-cum[j]) / dt = 0 regardless of secondsAgos.
        for (uint256 i = 0; i < n; i++) {
            tickCumulatives[i] = 0;
            secondsPerLiquidityCumulativeX128s[i] = 1;
        }
        return (tickCumulatives, secondsPerLiquidityCumulativeX128s);
    }
}
