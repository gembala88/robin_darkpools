// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ArbExecutor — atomic RobinFun-curve <-> Uniswap-V4 arbitrage for RH6900.
/// @notice Buys on the RobinFun bonding curve and sells into a Uniswap V4 pool
///         (or the reverse) in ONE transaction, reverting unless the contract's
///         ETH balance grows by at least `minProfit`. No inventory risk: if the
///         V4 leg can't meet the profit floor the whole tx reverts (gas only).
///
/// The contract holds a working ETH balance (deposit via receive()). Each arb
/// call spends from and returns to that balance. Owner can withdraw anytime.
/// Token is fixed (RH6900); the V4 PoolKey is passed per call so the off-chain
/// bot can route to whichever pool (10% or 25% tier) is most profitable.

interface ICurve {
    function buy(address token, uint256 minTokensOut) external payable returns (uint256 tokensOut);
    function sell(address token, uint256 tokensIn, uint256 minEthOut) external returns (uint256 ethOut);
}
interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}
interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}
interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

contract ArbExecutor {
    // --- Uniswap V4 command / action selectors ---
    uint8 private constant CMD_V4_SWAP = 0x10;
    uint8 private constant ACT_SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 private constant ACT_SETTLE_ALL = 0x0c;
    uint8 private constant ACT_TAKE_ALL = 0x0f;
    address private constant NATIVE = address(0);

    struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
    struct ExactInputSingleParams { PoolKey poolKey; bool zeroForOne; uint128 amountIn; uint128 amountOutMinimum; bytes hookData; }

    address public owner;
    ICurve public immutable curve;
    IUniversalRouter public immutable router;
    IPermit2 public immutable permit2;
    mapping(address => bool) public approved;   // token => approvals set

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address _curve, address _router, address _permit2) {
        owner = msg.sender;
        curve = ICurve(_curve);
        router = IUniversalRouter(_router);
        permit2 = IPermit2(_permit2);
    }

    receive() external payable {}

    /// @notice One-time approvals for a token so the Universal Router can pull it
    ///         via Permit2, and the curve can pull it on the reverse leg. Called
    ///         automatically on first use, or ahead of time by the owner.
    function approve(address token) public onlyOwner {
        IERC20(token).approve(address(permit2), type(uint256).max);
        permit2.approve(token, address(router), type(uint160).max, type(uint48).max);
        IERC20(token).approve(address(curve), type(uint256).max);
        approved[token] = true;
    }
    function _ensure(address token) internal { if (!approved[token]) approve(token); }

    // internal: BUY token on curve -> SELL into V4 pool. Returns pre-trade balance.
    function _curveToV4(address token, uint256 ethIn, uint256 minTokensOut, PoolKey calldata key, uint128 minEthOut)
        internal returns (uint256 balBefore)
    {
        require(key.currency1 == token && key.currency0 == NATIVE, "bad key");
        _ensure(token);
        balBefore = address(this).balance;

        uint256 tokensOut = curve.buy{value: ethIn}(token, minTokensOut);
        // sell exactly tokensOut on V4 (token1 -> token0/ETH => zeroForOne = false)
        bytes memory actions = abi.encodePacked(ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(ExactInputSingleParams({
            poolKey: key, zeroForOne: false,
            amountIn: uint128(tokensOut), amountOutMinimum: minEthOut, hookData: ""
        }));
        params[1] = abi.encode(key.currency1, tokensOut);
        params[2] = abi.encode(key.currency0, uint256(minEthOut));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        router.execute(abi.encodePacked(CMD_V4_SWAP), inputs, block.timestamp);
    }

    // internal: BUY token on V4 pool -> SELL on curve. Returns pre-trade balance.
    function _v4ToCurve(address token, uint256 ethIn, uint128 minTokensOut, PoolKey calldata key, uint256 minEthOut)
        internal returns (uint256 balBefore)
    {
        require(key.currency1 == token && key.currency0 == NATIVE, "bad key");
        _ensure(token);
        balBefore = address(this).balance;

        bytes memory actions = abi.encodePacked(ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(ExactInputSingleParams({
            poolKey: key, zeroForOne: true,
            amountIn: uint128(ethIn), amountOutMinimum: minTokensOut, hookData: ""
        }));
        params[1] = abi.encode(key.currency0, ethIn);
        params[2] = abi.encode(key.currency1, uint256(minTokensOut));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        router.execute{value: ethIn}(abi.encodePacked(CMD_V4_SWAP), inputs, block.timestamp);

        uint256 got = IERC20(token).balanceOf(address(this));
        curve.sell(token, got, minEthOut);
    }

    /// @notice BUY curve -> SELL V4. Reverts unless net ETH gain >= minProfit.
    function curveToV4(address token, uint256 ethIn, uint256 minTokensOut, PoolKey calldata key, uint128 minEthOut, uint256 minProfit) external onlyOwner {
        uint256 balBefore = _curveToV4(token, ethIn, minTokensOut, key, minEthOut);
        require(address(this).balance >= balBefore + minProfit, "no profit");
    }
    /// @notice BUY V4 -> SELL curve. Reverts unless net ETH gain >= minProfit.
    function v4ToCurve(address token, uint256 ethIn, uint128 minTokensOut, PoolKey calldata key, uint256 minEthOut, uint256 minProfit) external onlyOwner {
        uint256 balBefore = _v4ToCurve(token, ethIn, minTokensOut, key, minEthOut);
        require(address(this).balance >= balBefore + minProfit, "no profit");
    }

    /// @notice Owner-only manual override / test — executes even at a LOSS. Only the
    ///         slippage floor (minEthOut) protects. Use for validating new pools.
    function forceCurveToV4(address token, uint256 ethIn, uint256 minTokensOut, PoolKey calldata key, uint128 minEthOut) external onlyOwner {
        _curveToV4(token, ethIn, minTokensOut, key, minEthOut);
    }
    function forceV4ToCurve(address token, uint256 ethIn, uint128 minTokensOut, PoolKey calldata key, uint256 minEthOut) external onlyOwner {
        _v4ToCurve(token, ethIn, minTokensOut, key, minEthOut);
    }

    // --- admin ---
    function withdraw(uint256 amount) external onlyOwner {
        (bool ok, ) = payable(owner).call{value: amount}("");
        require(ok, "withdraw failed");
    }
    function rescueToken(address t, uint256 amount) external onlyOwner {
        IERC20(t).transfer(owner, amount);
    }
    function setOwner(address o) external onlyOwner { require(o != address(0), "zero owner"); owner = o; }
}
