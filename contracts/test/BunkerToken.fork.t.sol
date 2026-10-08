// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {BunkerToken, PoolKey, IPositionManager} from "../src/BunkerToken.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2Approve {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

struct ExactInputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    bytes hookData;
}

/// Runs against a mainnet fork (real Uniswap v4):  forge test --match-contract BunkerTokenFork --fork-url <rpc>
contract BunkerTokenForkTest is Test {
    IUniversalRouter constant UR = IUniversalRouter(0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af);
    IPositionManager constant PM = IPositionManager(0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e);
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;

    // ~$5k opening market cap: start tick 200400, whole supply single-sided down to the bottom of the curve
    uint160 constant SQRT_START = 1779478419032188924193855251423147;
    int24 constant TICK_UPPER = 200400;
    int24 constant TICK_LOWER = -887200;
    uint128 constant LIQ = 44523249996678482940644;

    BunkerToken token;
    address deployer = makeAddr("bunker-fork-deployer-91f3");
    address fees = makeAddr("bunker-fork-fees-91f3");
    address alice = makeAddr("bunker-fork-alice-91f3");
    address bob = makeAddr("bunker-fork-bob-91f3");

    function setUp() public {
        if (block.chainid != 1) vm.skip(true);
        vm.prank(deployer);
        token = new BunkerToken(fees);
    }

    function _launch() internal {
        vm.prank(deployer);
        token.launch(10_000, 200, SQRT_START, TICK_LOWER, TICK_UPPER, LIQ);
    }

    function _key() internal view returns (PoolKey memory k) {
        (address c0, address c1, uint24 fee, int24 sp, address h) = token.poolKey();
        k = PoolKey(c0, c1, fee, sp, h);
    }

    function _buy(address who, uint256 ethIn) internal returns (uint256 got) {
        bytes[] memory p = new bytes[](3);
        p[0] = abi.encode(ExactInputSingleParams(_key(), true, uint128(ethIn), 0, ""));
        p[1] = abi.encode(address(0), ethIn);
        p[2] = abi.encode(address(token), uint256(0));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(uint8(0x06), uint8(0x0c), uint8(0x0f)), p); // SWAP_IN_SINGLE, SETTLE_ALL, TAKE_ALL
        vm.deal(who, who.balance + ethIn);
        uint256 b0 = token.balanceOf(who);
        vm.prank(who);
        UR.execute{value: ethIn}(hex"10", inputs, block.timestamp);
        got = token.balanceOf(who) - b0;
    }

    function _sell(address who, uint256 amount) internal returns (uint256 ethOut) {
        vm.startPrank(who);
        token.approve(PERMIT2, amount);
        IPermit2Approve(PERMIT2).approve(address(token), address(UR), uint160(amount), uint48(block.timestamp + 600));
        bytes[] memory p = new bytes[](3);
        p[0] = abi.encode(ExactInputSingleParams(_key(), false, uint128(amount), 0, ""));
        p[1] = abi.encode(address(token), amount);
        p[2] = abi.encode(address(0), uint256(0));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(uint8(0x06), uint8(0x0c), uint8(0x0f)), p);
        uint256 e0 = who.balance;
        UR.execute(hex"10", inputs, block.timestamp);
        vm.stopPrank();
        ethOut = who.balance - e0;
    }

    function test_launch_locks_whole_supply_in_the_contract() public {
        assertEq(token.balanceOf(address(token)), 1e27);
        _launch();
        uint256 id = token.lpTokenId();
        assertGt(id, 0);
        assertEq(PM.ownerOf(id), address(token), "LP NFT held by the token contract");
        assertEq(token.lockedLiquidity(), LIQ);
        assertEq(token.balanceOf(address(token)), 0);
        uint256 dust = token.balanceOf(token.DEAD());
        assertLt(dust, 1e12, "only rounding dust burned");
        assertEq(token.balanceOf(POOL_MANAGER) + dust, 1e27, "everything else is in the pool");
        console2.log("burned rounding dust (wei)", dust);
    }

    function test_launch_only_owner_only_once() public {
        vm.prank(alice);
        vm.expectRevert(BunkerToken.NotOwner.selector);
        token.launch(10_000, 200, SQRT_START, TICK_LOWER, TICK_UPPER, LIQ);
        _launch();
        vm.prank(deployer);
        vm.expectRevert(BunkerToken.AlreadyLaunched.selector);
        token.launch(10_000, 200, SQRT_START, TICK_LOWER, TICK_UPPER, LIQ);
    }

    function test_max_wallet_2pct() public {
        _launch();
        uint256 got = _buy(alice, 0.03 ether);
        assertGt(got, 0);
        assertLe(token.balanceOf(alice), token.MAX_WALLET());
        console2.log("0.03 ETH bought (bp of supply)", got * 10_000 / 1e27);
        // a buy that would take alice past 20,000,000 reverts
        vm.expectRevert();
        this.buyExt(alice, 0.05 ether);
        // the deployer is NOT exempt
        vm.expectRevert();
        this.buyExt(deployer, 0.2 ether);
        // plain transfers are capped too
        _buy(bob, 0.03 ether);
        uint256 bobBal = token.balanceOf(bob);
        vm.prank(bob);
        vm.expectRevert(BunkerToken.MaxWallet.selector);
        token.transfer(alice, bobBal);
        // selling (into the pool) always works
        uint256 out = _sell(bob, bobBal / 2);
        assertGt(out, 0);
    }

    function buyExt(address who, uint256 ethIn) external returns (uint256) {
        return _buy(who, ethIn);
    }

    function test_remove_limits_is_one_way_and_owner_only() public {
        _launch();
        vm.prank(alice);
        vm.expectRevert(BunkerToken.NotOwner.selector);
        token.removeLimits();
        vm.prank(deployer);
        token.removeLimits();
        assertFalse(token.limitsInEffect());
        uint256 got = _buy(alice, 0.3 ether);
        assertGt(got, token.MAX_WALLET(), "big buy works once limits are off");
        vm.prank(deployer);
        token.renounceOwnership();
        assertEq(token.owner(), address(0));
    }

    function test_fees_go_to_recipient_and_liquidity_never_moves() public {
        _launch();
        _buy(alice, 0.03 ether);
        _buy(bob, 0.02 ether);
        _sell(alice, token.balanceOf(alice));
        uint128 liq = token.lockedLiquidity();
        vm.prank(makeAddr("bunker-fork-anyone-91f3"));
        (uint256 ethOut, uint256 bunkerOut) = token.collectFees();
        assertApproxEqRel(ethOut, 0.0005 ether, 0.02e18, "1% of 0.05 ETH of buys");
        assertGt(bunkerOut, 0, "1% of the sell, in BUNKER");
        assertEq(fees.balance, ethOut);
        assertEq(token.lockedLiquidity(), liq, "liquidity untouched");
        // nobody can pull liquidity: the token has no such function and the NFT is not approved to anyone
        bytes[] memory p = new bytes[](2);
        p[0] = abi.encode(token.lpTokenId(), uint256(liq), uint128(0), uint128(0), bytes(""));
        p[1] = abi.encode(address(0), address(token), deployer);
        vm.prank(deployer);
        vm.expectRevert();
        PM.modifyLiquidities(abi.encode(abi.encodePacked(uint8(0x01), uint8(0x11)), p), block.timestamp);
        assertEq(token.lockedLiquidity(), liq);
    }

    function test_fee_recipient_handover() public {
        vm.prank(alice);
        vm.expectRevert(bytes("not recipient"));
        token.setFeeRecipient(alice);
        vm.prank(fees);
        token.setFeeRecipient(bob);
        assertEq(token.feeRecipient(), bob);
    }

    /// Someone pre-creates our exact pool at a higher price to block the launch: the launch reverts (nothing lost),
    /// and the deployer launches on another fee tier.
    function test_squatted_pool_reverts_then_other_tier_works() public {
        PoolKey memory k = PoolKey(address(0), address(token), 10_000, 200, address(0));
        PM.initializePool(k, 1610146708304539256139594963901528); // 2,000 ticks below our start = 20% pricier
        vm.prank(deployer);
        vm.expectRevert();
        token.launch(10_000, 200, SQRT_START, TICK_LOWER, TICK_UPPER, LIQ);
        vm.prank(deployer);
        token.launch(3_000, 60, SQRT_START, -887220, TICK_UPPER, LIQ);
        assertEq(PM.ownerOf(token.lpTokenId()), address(token));
        assertGt(_buy(alice, 0.02 ether), 0);
    }
}
