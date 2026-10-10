// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {BunkerSwap, BunkerBox, IBunkerVault, IUniversalRouter, Tokens} from "../src/BunkerSwap.sol";
import {BunkerVault} from "../src/BunkerVault.sol";
import {Wots, FeeToken} from "./BunkerVault.t.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

interface ILiveVault is IBunkerVault {
    function digest(bytes32 id, Transfer[] calldata transfers, address relayer, uint256 fee, bytes32 nextKey)
        external
        view
        returns (bytes32);
    function accounts(bytes32 id) external view returns (bytes32 key, uint64 nonce);
    function balanceOf(bytes32 id, address token) external view returns (uint256);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external;
}

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct ExactInputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    bytes hookData;
}

struct Route {
    bytes commands;
    bytes[] inputs;
}

/// ERC-20 whose transfers to chosen addresses can be switched off, and that can try to re-enter BunkerSwap.
contract SwitchToken is MockERC20("Switch", "SWT", 18) {
    mapping(address => bool) public blockedTo;
    BunkerSwap public target;
    BunkerSwap.Order public order;
    bool public reentered;

    function blockTo(address a, bool b) external {
        blockedTo[a] = b;
    }

    function arm(BunkerSwap t, BunkerSwap.Order calldata o) external {
        target = t;
        order = o;
    }

    function _hook(address to) internal {
        require(!blockedTo[to], "blocked");
        if (address(target) != address(0)) {
            try target.rescue(order, address(this)) {
                reentered = true;
            } catch {}
        }
    }

    function transfer(address to, uint256 v) external override returns (bool) {
        _hook(to);
        return _t(msg.sender, to, v);
    }

    function transferFrom(address f, address to, uint256 v) external override returns (bool) {
        _hook(to);
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= v;
        return _t(f, to, v);
    }
}

contract Toggle {
    bool public open;

    function set(bool o) external {
        open = o;
    }

    receive() external payable {
        require(open, "closed");
    }
}

/// Runs against a mainnet fork (the live BunkerVault, the real Universal Router and real pools):
///   forge test --match-contract BunkerSwapFork --fork-url <rpc>
contract BunkerSwapForkTest is Test {
    ILiveVault constant VAULT = ILiveVault(0x39C71b635409b1f98dc632e08d3B29515ddb2727);
    IUniversalRouter constant UR = IUniversalRouter(0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af);
    address constant BUNKER = 0xBDC4cE7c4718d20498e7D549751FF336690eb6D7;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address constant ETH = address(0);
    uint256 constant FEE_BPS = 50;
    uint256 constant CONTRACT_BALANCE = 1 << 255;
    address constant MSG_SENDER = address(1);
    address constant ADDRESS_THIS = address(2);

    BunkerSwap swap;
    address platform = makeAddr("bunker-swap-platform-7c1");
    address relayer = makeAddr("bunker-swap-relayer-7c1");
    address funder = makeAddr("bunker-swap-funder-7c1");
    uint256 seed = uint256(keccak256("bunker-swap-fork-seed-7c1"));
    bytes32 id;
    /// ETH that already sits at the address the test deploys to (people send dust to well-known test addresses on
    /// mainnet). It must stay put: stray ETH is never handed to a swapper.
    uint256 stray;

    function setUp() public {
        if (block.chainid != 1) vm.skip(true);
        swap = new BunkerSwap(VAULT, UR, platform, FEE_BPS);
        stray = address(swap).balance;
        id = Wots.pk(seed, 0);
        vm.deal(funder, 100 ether);
        vm.prank(funder);
        VAULT.depositETH{value: 10 ether}(id);
    }

    // ------------------------------------------------------------------ helpers

    function _nonce() internal view returns (uint64 n) {
        (, n) = VAULT.accounts(id);
    }

    function _order(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, uint256 tip, Route memory r)
        internal
        view
        returns (BunkerSwap.Order memory)
    {
        return BunkerSwap.Order(
            id,
            _nonce(),
            tokenIn,
            tokenOut,
            amountIn,
            minOut,
            tip,
            address(0),
            uint64(block.timestamp + 600),
            keccak256(abi.encode(r.commands, r.inputs))
        );
    }

    function _sign(BunkerSwap.Order memory o) internal view returns (bytes32 nextKey, bytes32[67] memory sig) {
        nextKey = Wots.pk(seed, o.nonce + 1);
        IBunkerVault.Transfer[] memory t = new IBunkerVault.Transfer[](1);
        t[0] = IBunkerVault.Transfer(o.tokenIn, swap.boxOf(o), o.amountIn);
        sig = Wots.sign(seed, o.nonce, VAULT.digest(o.id, t, address(swap), 0, nextKey));
    }

    function _run(BunkerSwap.Order memory o, Route memory r, address who) internal {
        (bytes32 nextKey, bytes32[67] memory sig) = _sign(o);
        vm.prank(who);
        swap.run(o, nextKey, sig, r.commands, r.inputs);
    }

    /// Uniswap v4, one pool: settle whatever the router holds, swap all of it, take everything out to the caller.
    function _v4(address tokenIn, address tokenOut, uint24 fee, int24 spacing) internal pure returns (Route memory r) {
        (address c0, address c1) = tokenIn < tokenOut ? (tokenIn, tokenOut) : (tokenOut, tokenIn);
        bytes[] memory p = new bytes[](3);
        p[0] = abi.encode(tokenIn, CONTRACT_BALANCE, false);
        p[1] = abi.encode(ExactInputSingleParams(PoolKey(c0, c1, fee, spacing, address(0)), tokenIn == c0, 0, 0, ""));
        p[2] = abi.encode(tokenOut, uint256(0));
        r.commands = hex"10";
        r.inputs = new bytes[](1);
        r.inputs[0] = abi.encode(abi.encodePacked(uint8(0x0b), uint8(0x06), uint8(0x0f)), p); // SETTLE, SWAP_IN_SINGLE, TAKE_ALL
    }

    function _v3Buy(address token, uint24 fee) internal pure returns (Route memory r) {
        r.commands = hex"0b00"; // WRAP_ETH, V3_SWAP_EXACT_IN
        r.inputs = new bytes[](2);
        r.inputs[0] = abi.encode(ADDRESS_THIS, CONTRACT_BALANCE);
        r.inputs[1] = abi.encode(MSG_SENDER, CONTRACT_BALANCE, uint256(0), abi.encodePacked(WETH, fee, token), false);
    }

    function _v3Sell(address token, uint24 fee) internal pure returns (Route memory r) {
        r.commands = hex"000c"; // V3_SWAP_EXACT_IN, UNWRAP_WETH
        r.inputs = new bytes[](2);
        r.inputs[0] = abi.encode(ADDRESS_THIS, CONTRACT_BALANCE, uint256(0), abi.encodePacked(token, fee, WETH), false);
        r.inputs[1] = abi.encode(MSG_SENDER, uint256(0));
    }

    function _v2(address token, bool buy) internal pure returns (Route memory r) {
        address[] memory path = new address[](2);
        (path[0], path[1]) = buy ? (WETH, token) : (token, WETH);
        r.inputs = new bytes[](2);
        if (buy) {
            r.commands = hex"0b08"; // WRAP_ETH, V2_SWAP_EXACT_IN
            r.inputs[0] = abi.encode(ADDRESS_THIS, CONTRACT_BALANCE);
            r.inputs[1] = abi.encode(MSG_SENDER, CONTRACT_BALANCE, uint256(0), path, false);
        } else {
            r.commands = hex"080c"; // V2_SWAP_EXACT_IN, UNWRAP_WETH
            r.inputs[0] = abi.encode(ADDRESS_THIS, CONTRACT_BALANCE, uint256(0), path, false);
            r.inputs[1] = abi.encode(MSG_SENDER, uint256(0));
        }
    }

    function _bunkerRoute(bool buy) internal pure returns (Route memory) {
        return buy ? _v4(ETH, BUNKER, 10_000, 200) : _v4(BUNKER, ETH, 10_000, 200);
    }

    function _assertClean(BunkerSwap.Order memory o) internal view {
        address box = swap.boxOf(o);
        assertEq(address(swap).balance, swap.owed() + stray, "swap holds only owed fees");
        assertEq(box.balance, 0, "box empty (ETH)");
        if (o.tokenIn != ETH) {
            assertEq(IERC20(o.tokenIn).balanceOf(box), 0, "box empty (token in)");
            assertEq(IERC20(o.tokenIn).balanceOf(address(swap)), 0, "swap holds no token in");
        }
        if (o.tokenOut != ETH) assertEq(IERC20(o.tokenOut).balanceOf(address(swap)), 0, "swap holds no token out");
    }

    function _buyBunker(uint256 ethIn) internal returns (uint256 out) {
        Route memory r = _bunkerRoute(true);
        BunkerSwap.Order memory o = _order(ETH, BUNKER, ethIn, 1, 0, r);
        uint256 b0 = VAULT.balanceOf(id, BUNKER);
        _run(o, r, funder);
        out = VAULT.balanceOf(id, BUNKER) - b0;
    }

    // ------------------------------------------------------------------ swaps

    function test_buy_v4_bunker() public {
        Route memory r = _bunkerRoute(true);
        BunkerSwap.Order memory o = _order(ETH, BUNKER, 1 ether, 1, 0, r);
        (bytes32 nextKey, bytes32[67] memory sig) = _sign(o);
        uint256 urBunker = IERC20(BUNKER).balanceOf(address(UR));
        uint256 funderEth = funder.balance;

        vm.prank(funder);
        uint256 g = gasleft();
        swap.run(o, nextKey, sig, r.commands, r.inputs);
        console2.log("gas: buy v4", g - gasleft());

        uint256 out = VAULT.balanceOf(id, BUNKER);
        assertGt(out, 0, "bunker credited with BUNKER");
        assertEq(VAULT.balanceOf(id, ETH), 9 ether, "exactly 1 ETH left the bunker");
        assertEq(platform.balance, 0.005 ether, "0.5% of the ETH side to the platform");
        assertEq(funder.balance, funderEth, "submitter paid nothing but gas, got no tip");
        assertEq(_nonce(), 1, "key rotated");
        assertEq(IERC20(BUNKER).balanceOf(address(UR)), urBunker, "nothing left in the router");
        _assertClean(o);
        console2.log("1 ETH ->", out / 1e18, "BUNKER");
    }

    /// Dry run: the net ETH a sell of `amount` BUNKER credits right now.
    function _probeSell(uint256 amount, uint256 tip) internal returns (uint256 net) {
        Route memory r = _bunkerRoute(false);
        uint256 snap = vm.snapshotState();
        uint256 e0 = VAULT.balanceOf(id, ETH);
        _run(_order(BUNKER, ETH, amount, 1, tip, r), r, relayer);
        net = VAULT.balanceOf(id, ETH) - e0;
        vm.revertToState(snap);
    }

    function test_sell_v4_bunker_relayed_with_tip() public {
        uint256 bought = _buyBunker(1 ether);
        uint256 tip = 0.001 ether;
        uint256 net = _probeSell(bought / 2, tip);
        Route memory r = _bunkerRoute(false);
        BunkerSwap.Order memory o = _order(BUNKER, ETH, bought / 2, net, tip, r); // demand exactly what the pool gives
        (bytes32 nextKey, bytes32[67] memory sig) = _sign(o);
        uint256 p0 = platform.balance;
        vm.prank(relayer);
        uint256 g = gasleft();
        swap.run(o, nextKey, sig, r.commands, r.inputs);
        console2.log("gas: sell v4", g - gasleft());

        uint256 fee = platform.balance - p0;
        assertEq(VAULT.balanceOf(id, ETH), 9 ether + net, "bunker credited with the net ETH");
        assertEq(relayer.balance, tip, "relayer got the tip");
        assertEq(fee, ((net + fee + tip) * FEE_BPS) / 10_000, "fee is 0.5% of the gross ETH out");
        assertEq(VAULT.balanceOf(id, BUNKER), bought - bought / 2, "only the sold half left");
        assertEq(_nonce(), 2);
        _assertClean(o);
    }

    function test_sell_oneWeiTooGreedy_changesNothing() public {
        uint256 bought = _buyBunker(1 ether);
        uint256 net = _probeSell(bought / 2, 0);
        Route memory r = _bunkerRoute(false);
        BunkerSwap.Order memory o = _order(BUNKER, ETH, bought / 2, net + 1, 0, r);
        (bytes32 nextKey, bytes32[67] memory sig) = _sign(o);
        vm.prank(relayer);
        vm.expectPartialRevert(BunkerSwap.TooLittle.selector);
        swap.run(o, nextKey, sig, r.commands, r.inputs);
        assertEq(_nonce(), 1, "a failed swap does not burn the key");
        assertEq(VAULT.balanceOf(id, BUNKER), bought);
    }

    function _roundTrip(address token, Route memory buy, Route memory sell, string memory label) internal {
        uint256 n = _nonce();
        BunkerSwap.Order memory o = _order(ETH, token, 0.5 ether, 1, 0, buy);
        (bytes32 nextKey, bytes32[67] memory sig) = _sign(o);
        vm.prank(funder);
        uint256 g = gasleft();
        swap.run(o, nextKey, sig, buy.commands, buy.inputs);
        console2.log(string.concat("gas: buy ", label), g - gasleft());
        uint256 got = VAULT.balanceOf(id, token);
        assertGt(got, 0, "token credited");
        _assertClean(o);

        uint256 eth0 = VAULT.balanceOf(id, ETH);
        o = _order(token, ETH, got, 1, 0.0005 ether, sell);
        (nextKey, sig) = _sign(o);
        vm.prank(relayer);
        g = gasleft();
        swap.run(o, nextKey, sig, sell.commands, sell.inputs);
        console2.log(string.concat("gas: sell ", label), g - gasleft());
        uint256 back = VAULT.balanceOf(id, ETH) - eth0;
        assertEq(VAULT.balanceOf(id, token), 0, "all sold");
        assertGt(back, 0.47 ether, "round trip keeps most of the ETH");
        assertLt(back, 0.5 ether);
        assertEq(_nonce(), n + 2);
        _assertClean(o);
    }

    function test_roundTrip_v3_usdc() public {
        _roundTrip(USDC, _v3Buy(USDC, 500), _v3Sell(USDC, 500), "v3 USDC");
    }

    function test_roundTrip_v3_usdt_noReturnToken() public {
        _roundTrip(USDT, _v3Buy(USDT, 500), _v3Sell(USDT, 500), "v3 USDT");
    }

    function test_roundTrip_v2_usdc() public {
        _roundTrip(USDC, _v2(USDC, true), _v2(USDC, false), "v2 USDC");
    }

    function test_roundTrip_v4_usdc() public {
        _roundTrip(USDC, _v4(ETH, USDC, 500, 10), _v4(USDC, ETH, 500, 10), "v4 USDC");
    }

    function test_unspentEthGoesBackToTheBunker() public {
        // a route that only swaps 0.4 of the ETH it is given and sweeps the rest back to the caller
        bytes[] memory p = new bytes[](3);
        p[0] = abi.encode(ExactInputSingleParams(PoolKey(ETH, BUNKER, 10_000, 200, address(0)), true, 0.4 ether, 0, ""));
        p[1] = abi.encode(ETH, uint256(0.4 ether));
        p[2] = abi.encode(BUNKER, uint256(0));
        Route memory r;
        r.commands = hex"1004"; // V4_SWAP, SWEEP
        r.inputs = new bytes[](2);
        r.inputs[0] = abi.encode(abi.encodePacked(uint8(0x06), uint8(0x0c), uint8(0x0f)), p);
        r.inputs[1] = abi.encode(ETH, MSG_SENDER, uint256(0));

        BunkerSwap.Order memory o = _order(ETH, BUNKER, 1 ether, 1, 0, r);
        _run(o, r, funder);
        // 1 ETH out, 0.005 fee, 0.4 swapped, 0.595 handed back
        assertEq(VAULT.balanceOf(id, ETH), 9 ether + 0.595 ether);
        assertEq(platform.balance, 0.005 ether);
        _assertClean(o);
    }

    function test_anyoneMaySubmit_andGetsTheTip() public {
        Route memory r = _bunkerRoute(true);
        BunkerSwap.Order memory o = _order(ETH, BUNKER, 1 ether, 1, 0.002 ether, r);
        address stranger = makeAddr("bunker-swap-stranger-7c1");
        _run(o, r, stranger);
        assertEq(stranger.balance, 0.002 ether);
        assertGt(VAULT.balanceOf(id, BUNKER), 0, "output still went to the bunker that signed");
        assertEq(IERC20(BUNKER).balanceOf(stranger), 0);
    }

    // ------------------------------------------------------------------ tampering

    function test_changedRoute_reverts() public {
        Route memory r = _bunkerRoute(true);
        BunkerSwap.Order memory o = _order(ETH, BUNKER, 1 ether, 1, 0, r);
        (bytes32 nextKey, bytes32[67] memory sig) = _sign(o);
        Route memory evil = _v4(ETH, USDC, 500, 10);
        vm.expectRevert(BunkerSwap.BadRoute.selector);
        swap.run(o, nextKey, sig, evil.commands, evil.inputs);
    }

    function test_changedOrder_breaksTheSignature() public {
        Route memory r = _bunkerRoute(true);
        BunkerSwap.Order memory o = _order(ETH, BUNKER, 1 ether, 1e24, 0, r);
        (bytes32 nextKey, bytes32[67] memory sig) = _sign(o);

        BunkerSwap.Order memory x = _order(ETH, BUNKER, 1 ether, 1e24, 0, r);
        x.minOut = 0; // let it fill at any price
        vm.expectRevert(BunkerVault.BadSignature.selector);
        swap.run(x, nextKey, sig, r.commands, r.inputs);

        x = _order(ETH, BUNKER, 1 ether, 1e24, 0, r);
        x.id = Wots.pk(seed + 1, 0); // send the output to another bunker
        vm.expectRevert(BunkerVault.UnknownAccount.selector);
        swap.run(x, nextKey, sig, r.commands, r.inputs);

        x = _order(ETH, BUNKER, 1 ether, 1e24, 0, r);
        x.tip = 0.9 ether;
        vm.expectRevert(BunkerVault.BadSignature.selector);
        swap.run(x, nextKey, sig, r.commands, r.inputs);

        x = _order(ETH, BUNKER, 1 ether, 1e24, 0, r);
        x.amountIn = 10 ether;
        vm.expectRevert(BunkerVault.BadSignature.selector);
        swap.run(x, nextKey, sig, r.commands, r.inputs);

        x = _order(ETH, BUNKER, 1 ether, 1e24, 0, r);
        x.deadline = uint64(block.timestamp + 365 days);
        vm.expectRevert(BunkerVault.BadSignature.selector);
        swap.run(x, nextKey, sig, r.commands, r.inputs);
        assertEq(_nonce(), 0);
    }

    function test_swapSignatureIsUselessOutsideBunkerSwap() public {
        Route memory r = _bunkerRoute(true);
        BunkerSwap.Order memory o = _order(ETH, BUNKER, 1 ether, 1, 0, r);
        (bytes32 nextKey, bytes32[67] memory sig) = _sign(o);
        IBunkerVault.Transfer[] memory t = new IBunkerVault.Transfer[](1);
        t[0] = IBunkerVault.Transfer(ETH, swap.boxOf(o), 1 ether);
        vm.expectRevert(BunkerVault.NotRelayer.selector);
        VAULT.execute(id, t, address(swap), 0, nextKey, sig);
        // ...and not redirectable to a wallet
        t[0].to = address(this);
        vm.expectRevert(BunkerVault.BadSignature.selector);
        VAULT.execute(id, t, address(0), 0, nextKey, sig);
    }

    function test_badOrders() public {
        Route memory r = _bunkerRoute(true);
        BunkerSwap.Order memory o = _order(ETH, ETH, 1 ether, 1, 0, r);
        (bytes32 nextKey, bytes32[67] memory sig) = _sign(o);
        vm.expectRevert(BunkerSwap.BadOrder.selector);
        swap.run(o, nextKey, sig, r.commands, r.inputs);

        o = _order(USDC, BUNKER, 1e6, 1, 0, r);
        (nextKey, sig) = _sign(o);
        vm.expectRevert(BunkerSwap.BadOrder.selector);
        swap.run(o, nextKey, sig, r.commands, r.inputs);

        // tip + fee eat the whole input
        o = _order(ETH, BUNKER, 0.001 ether, 1, 0.001 ether, r);
        (nextKey, sig) = _sign(o);
        vm.expectRevert(BunkerSwap.BadOrder.selector);
        swap.run(o, nextKey, sig, r.commands, r.inputs);
    }

    function test_constructorChecks() public {
        vm.expectRevert(BunkerSwap.BadConfig.selector);
        new BunkerSwap(VAULT, UR, platform, 101);
        vm.expectRevert(BunkerSwap.BadConfig.selector);
        new BunkerSwap(VAULT, UR, address(0), 50);
        vm.expectRevert(BunkerSwap.BadConfig.selector);
        new BunkerSwap(IBunkerVault(makeAddr("no-code")), UR, platform, 50);
    }

    // ------------------------------------------------------------------ who may submit

    function test_submitterLock_onlyTheNamedAddressSwaps_anyoneHandsBack() public {
        Route memory r = _bunkerRoute(true);
        BunkerSwap.Order memory o = _order(ETH, BUNKER, 1 ether, 1, 0.001 ether, r);
        o.submitter = relayer;
        (bytes32 nextKey, bytes32[67] memory sig) = _sign(o);
        address sniper = makeAddr("bunker-swap-sniper-7c1");

        // a bot that copies the pending transaction gets nothing
        vm.prank(sniper);
        vm.expectRevert(BunkerSwap.NotSubmitter.selector);
        swap.run(o, nextKey, sig, r.commands, r.inputs);
        assertEq(_nonce(), 0);

        uint256 snap = vm.snapshotState();
        vm.prank(relayer);
        swap.run(o, nextKey, sig, r.commands, r.inputs);
        assertGt(VAULT.balanceOf(id, BUNKER), 0);
        assertEq(relayer.balance, 0.001 ether);
        vm.revertToState(snap);

        // if the named submitter never shows up, anyone can hand the order back once it has expired
        vm.warp(o.deadline + 1);
        vm.prank(sniper);
        swap.run(o, nextKey, sig, r.commands, r.inputs);
        assertEq(_nonce(), 1, "the bunker is not stuck");
        assertEq(VAULT.balanceOf(id, ETH), 10 ether - 0.001 ether);
        assertEq(VAULT.balanceOf(id, BUNKER), 0);
    }

    function test_submitterIsPartOfTheSignedOrder() public {
        Route memory r = _bunkerRoute(true);
        BunkerSwap.Order memory o = _order(ETH, BUNKER, 1 ether, 1, 0.001 ether, r);
        o.submitter = relayer;
        (bytes32 nextKey, bytes32[67] memory sig) = _sign(o);
        o.submitter = address(this); // rewrite it to myself
        vm.expectRevert(BunkerVault.BadSignature.selector);
        swap.run(o, nextKey, sig, r.commands, r.inputs);
    }

    /// A deadline further away than MAX_LIFE can not freeze the bunker: the order is returnable straight away.
    function test_farDeadline_isOnlyReturnable() public {
        Route memory r = _bunkerRoute(true);
        BunkerSwap.Order memory o = _order(ETH, BUNKER, 1 ether, type(uint256).max, 0, r);
        o.deadline = type(uint64).max;
        (bytes32 nextKey, bytes32[67] memory sig) = _sign(o);
        swap.run(o, nextKey, sig, r.commands, r.inputs);
        assertEq(_nonce(), 1, "key rotated at once");
        assertEq(VAULT.balanceOf(id, ETH), 10 ether, "handed back, not swapped");
        assertEq(VAULT.balanceOf(id, BUNKER), 0);

        // exactly MAX_LIFE away is still a live swap
        o = _order(ETH, BUNKER, 1 ether, 1, 0, r);
        o.deadline = uint64(block.timestamp + swap.MAX_LIFE());
        (nextKey, sig) = _sign(o);
        swap.run(o, nextKey, sig, r.commands, r.inputs);
        assertGt(VAULT.balanceOf(id, BUNKER), 0);
    }

    // ------------------------------------------------------------------ after the deadline

    function test_expired_ethOrder_handsEverythingBack() public {
        Route memory r = _bunkerRoute(true);
        BunkerSwap.Order memory o = _order(ETH, BUNKER, 1 ether, type(uint256).max, 0.001 ether, r);
        (bytes32 nextKey, bytes32[67] memory sig) = _sign(o);

        // can not fill: nothing changes, the key is not burned
        vm.prank(relayer);
        vm.expectPartialRevert(BunkerSwap.TooLittle.selector);
        swap.run(o, nextKey, sig, r.commands, r.inputs);
        assertEq(_nonce(), 0);
        assertEq(VAULT.balanceOf(id, ETH), 10 ether);

        // same signature after the deadline: funds come back, key rotates, no swap fee
        vm.warp(o.deadline + 1);
        vm.prank(relayer);
        uint256 g = gasleft();
        swap.run(o, nextKey, sig, r.commands, r.inputs);
        console2.log("gas: hand back ETH", g - gasleft());
        assertEq(_nonce(), 1, "key rotated");
        assertEq(VAULT.balanceOf(id, ETH), 10 ether - 0.001 ether, "all back but the tip");
        assertEq(relayer.balance, 0.001 ether);
        assertEq(platform.balance, 0, "no fee on a returned order");
        assertEq(VAULT.balanceOf(id, BUNKER), 0);
        _assertClean(o);

        // and the bunker works as usual with the next key
        assertGt(_buyBunker(1 ether), 0);
    }

    function test_expired_tokenOrder_handsTokensBack_noTip() public {
        uint256 bought = _buyBunker(1 ether);
        Route memory r = _bunkerRoute(false);
        BunkerSwap.Order memory o = _order(BUNKER, ETH, bought, type(uint128).max, 0.001 ether, r);
        (bytes32 nextKey, bytes32[67] memory sig) = _sign(o);
        vm.warp(o.deadline + 1);
        vm.prank(relayer);
        uint256 g = gasleft();
        swap.run(o, nextKey, sig, r.commands, r.inputs);
        console2.log("gas: hand back token", g - gasleft());
        assertEq(VAULT.balanceOf(id, BUNKER), bought, "tokens back in the bunker");
        assertEq(VAULT.balanceOf(id, ETH), 9 ether);
        assertEq(relayer.balance, 0, "a tip is only ever paid out of ETH");
        assertEq(_nonce(), 2);
        _assertClean(o);
    }

    function test_expired_garbageRouteStillReturns() public {
        Route memory r; // a route nobody could execute; irrelevant after the deadline
        r.commands = hex"ff";
        r.inputs = new bytes[](0);
        BunkerSwap.Order memory o = _order(ETH, BUNKER, 2 ether, 1, 0, r);
        (bytes32 nextKey, bytes32[67] memory sig) = _sign(o);
        vm.expectRevert();
        swap.run(o, nextKey, sig, r.commands, r.inputs);
        vm.warp(o.deadline + 1);
        swap.run(o, nextKey, sig, hex"", new bytes[](0)); // route not even needed
        assertEq(VAULT.balanceOf(id, ETH), 10 ether);
        assertEq(_nonce(), 1);
    }

    /// For every gas limit the submitter can pick, a post-deadline run either reverts or returns the funds in full.
    function test_expired_lowGasCanNotStrand() public {
        Route memory r = _bunkerRoute(true);
        BunkerSwap.Order memory o = _order(ETH, BUNKER, 1 ether, 1, 0, r);
        (bytes32 nextKey, bytes32[67] memory sig) = _sign(o);
        vm.warp(o.deadline + 1);
        uint256 ok;
        for (uint256 g = 100_000; g <= 1_200_000; g += 25_000) {
            uint256 snap = vm.snapshotState();
            try swap.run{gas: g}(o, nextKey, sig, r.commands, r.inputs) {
                ++ok;
                assertEq(VAULT.balanceOf(id, ETH), 10 ether, "returned in full");
                assertEq(swap.boxOf(o).balance, 0, "nothing stranded");
            } catch {
                assertEq(_nonce(), 0);
            }
            vm.revertToState(snap);
        }
        assertGt(ok, 0);
    }

    // ------------------------------------------------------------------ stranded funds

    function _switchToken() internal returns (SwitchToken t) {
        t = new SwitchToken();
        t.mint(funder, 1000 ether);
        vm.startPrank(funder);
        t.approve(address(VAULT), type(uint256).max);
        VAULT.deposit(id, address(t), 1000 ether);
        vm.stopPrank();
    }

    function test_stranded_boxCanNotPay_thenRescue() public {
        SwitchToken t = _switchToken();
        Route memory r;
        BunkerSwap.Order memory o = _order(address(t), ETH, 400 ether, 1, 0, r);
        (bytes32 nextKey, bytes32[67] memory sig) = _sign(o);
        address box = swap.boxOf(o);
        t.blockTo(address(swap), true);
        vm.warp(o.deadline + 1);

        vm.expectEmit(true, true, false, true, address(swap));
        emit BunkerSwap.Stranded(id, address(t), box);
        swap.run(o, nextKey, sig, r.commands, r.inputs);
        assertEq(_nonce(), 1, "the key still rotated: the bunker is not stuck");
        assertEq(t.balanceOf(box), 400 ether, "funds wait in the box");
        assertEq(VAULT.balanceOf(id, address(t)), 600 ether);

        vm.expectRevert();
        swap.rescue(o, address(t));

        t.blockTo(address(swap), false);
        vm.prank(makeAddr("anyone"));
        assertEq(swap.rescue(o, address(t)), 400 ether);
        assertEq(VAULT.balanceOf(id, address(t)), 1000 ether, "back in the same bunker");
        assertEq(t.balanceOf(box), 0);

        vm.expectRevert(BunkerSwap.NothingThere.selector);
        swap.rescue(o, address(t));
    }

    function test_stranded_vaultCouldNotSend_thenRescueClaims() public {
        SwitchToken t = _switchToken();
        Route memory r;
        BunkerSwap.Order memory o = _order(address(t), ETH, 400 ether, 1, 0, r);
        (bytes32 nextKey, bytes32[67] memory sig) = _sign(o);
        address box = swap.boxOf(o);
        t.blockTo(box, true);

        // before the deadline nothing can be swapped, so nothing happens
        vm.expectRevert();
        swap.run(o, nextKey, sig, r.commands, r.inputs);
        assertEq(_nonce(), 0);

        vm.warp(o.deadline + 1);
        swap.run(o, nextKey, sig, r.commands, r.inputs);
        assertEq(_nonce(), 1);
        assertEq(VAULT.claimable(box, address(t)), 400 ether, "the vault owes the box");

        t.blockTo(box, false);
        assertEq(swap.rescue(o, address(t)), 400 ether);
        assertEq(VAULT.balanceOf(id, address(t)), 1000 ether);
        assertEq(VAULT.claimable(box, address(t)), 0);
    }

    /// A token that takes 10% on every transfer: nothing may get stuck on the way back (three hops = 72.9% left).
    function test_taxedToken_expiredOrderStillReturns() public {
        FeeToken t = new FeeToken();
        t.mint(funder, 1000 ether);
        vm.startPrank(funder);
        t.approve(address(VAULT), type(uint256).max);
        VAULT.deposit(id, address(t), 1000 ether);
        vm.stopPrank();
        assertEq(VAULT.balanceOf(id, address(t)), 900 ether);

        Route memory r;
        BunkerSwap.Order memory o = _order(address(t), ETH, 900 ether, 1, 0, r);
        (bytes32 nextKey, bytes32[67] memory sig) = _sign(o);
        vm.warp(o.deadline + 1);
        vm.expectEmit(true, true, false, true, address(swap));
        emit BunkerSwap.Returned(id, address(t), 729 ether, address(this));
        swap.run(o, nextKey, sig, r.commands, r.inputs);
        assertEq(VAULT.balanceOf(id, address(t)), 656.1 ether, "everything that survived the token tax is back");
        assertEq(t.balanceOf(swap.boxOf(o)), 0);
        assertEq(t.balanceOf(address(swap)), 0);
    }

    function test_taxedToken_rescueWorks() public {
        FeeToken t = new FeeToken();
        Route memory r;
        BunkerSwap.Order memory o = _order(address(t), ETH, 1, 1, 0, r);
        t.mint(swap.boxOf(o), 100 ether);
        swap.rescue(o, address(t));
        assertEq(VAULT.balanceOf(id, address(t)), 81 ether);
    }

    /// The vault could not deliver the tokens (it books them as claimable). Dust in the box must not turn that into
    /// a "swap" of the dust that burns the key and leaves the real amount behind.
    function test_vaultCouldNotDeliver_dustCanNotFakeASwap() public {
        SwitchToken t = _switchToken();
        Route memory r;
        BunkerSwap.Order memory o = _order(address(t), ETH, 400 ether, 0, 0, r);
        (bytes32 nextKey, bytes32[67] memory sig) = _sign(o);
        address box = swap.boxOf(o);
        t.mint(box, 1); // attacker's dust, sent before the transfer is blocked
        t.mint(address(swap), 1);
        t.blockTo(box, true);
        vm.expectRevert(BunkerSwap.NothingThere.selector);
        swap.run(o, nextKey, sig, r.commands, r.inputs);
        assertEq(_nonce(), 0, "key not burned");
        assertEq(VAULT.balanceOf(id, address(t)), 1000 ether);
        assertEq(VAULT.claimable(box, address(t)), 0);
    }

    /// Tokens that end up in BunkerSwap by mistake belong to nobody's order: no order and no rescue can take them.
    function test_strayTokens_areNotHandedOut() public {
        SwitchToken t = new SwitchToken();
        t.mint(address(swap), 1000 ether);
        Route memory r;
        BunkerSwap.Order memory mine = _order(address(t), ETH, 1, 1, 0, r);
        vm.expectRevert(BunkerSwap.NothingThere.selector);
        swap.rescue(mine, address(t));
        assertEq(t.balanceOf(address(swap)), 1000 ether);

        // nor does a buy of that token pick them up
        deal(USDC, address(swap), 500e6);
        Route memory buy = _v3Buy(USDC, 500);
        uint256 snap = vm.snapshotState();
        deal(USDC, address(swap), 0);
        _run(_order(ETH, USDC, 0.5 ether, 1, 0, buy), buy, funder);
        uint256 honest = VAULT.balanceOf(id, USDC);
        vm.revertToState(snap);
        _run(_order(ETH, USDC, 0.5 ether, 1, 0, buy), buy, funder);
        assertEq(VAULT.balanceOf(id, USDC), honest, "credited the swap output only");
        assertEq(IERC20(USDC).balanceOf(address(swap)), 500e6, "strays stay put");

        // nor a sell
        Route memory sell = _v3Sell(USDC, 500);
        _run(_order(USDC, ETH, honest, 1, 0, sell), sell, funder);
        assertEq(VAULT.balanceOf(id, USDC), 0);
        assertEq(IERC20(USDC).balanceOf(address(swap)), 500e6);
    }

    function test_rescue_returnsStrayFundsOfAnyToken() public {
        Route memory r = _bunkerRoute(true);
        BunkerSwap.Order memory o = _order(ETH, BUNKER, 1 ether, 1, 0, r);
        address box = swap.boxOf(o);
        vm.deal(box, 0.3 ether); // somebody sends ETH to a box that was never used
        swap.rescue(o, ETH);
        assertEq(VAULT.balanceOf(id, ETH), 10.3 ether);
        assertEq(box.balance, 0);
        _run(o, r, funder); // the order itself still works afterwards (box already deployed)
        assertGt(VAULT.balanceOf(id, BUNKER), 0);
    }

    function test_tokenCanNotReenter() public {
        SwitchToken t = _switchToken();
        Route memory r;
        BunkerSwap.Order memory o = _order(address(t), ETH, 400 ether, 1, 0, r);
        (bytes32 nextKey, bytes32[67] memory sig) = _sign(o);
        t.arm(swap, o);
        vm.warp(o.deadline + 1);
        swap.run(o, nextKey, sig, r.commands, r.inputs);
        assertFalse(t.reentered(), "rescue is locked while run is in progress");
        assertEq(VAULT.balanceOf(id, address(t)), 1000 ether);
    }

    // ------------------------------------------------------------------ box

    function test_box_onlySwapCanSweep() public {
        Route memory r = _bunkerRoute(true);
        BunkerSwap.Order memory o = _order(ETH, BUNKER, 1 ether, 1, 0, r);
        address box = swap.boxOf(o);
        assertEq(box.code.length, 0, "no code before first use");
        _run(o, r, funder);
        assertEq(box.code.length, 45, "EIP-1167 proxy");
        vm.deal(box, 1 ether);
        vm.expectRevert(BunkerBox.NotSwap.selector);
        BunkerBox(payable(box)).sweep(ETH);
        address impl = swap.BOX();
        vm.expectRevert(BunkerBox.NotSwap.selector);
        BunkerBox(payable(impl)).sweep(ETH);
        assertEq(box.balance, 1 ether);
    }

    function test_boxAddress_dependsOnEveryField() public view {
        Route memory r = _bunkerRoute(true);
        BunkerSwap.Order memory o = _order(ETH, BUNKER, 1 ether, 1, 0, r);
        address a = swap.boxOf(o);
        BunkerSwap.Order memory x = _order(ETH, BUNKER, 1 ether, 1, 0, r); // a copy, not an alias
        x.nonce += 1;
        assertTrue(swap.boxOf(x) != a);
        x.nonce = o.nonce;
        x.minOut += 1;
        assertTrue(swap.boxOf(x) != a);
        x.minOut = o.minOut;
        x.route = bytes32(uint256(o.route) ^ 1);
        assertTrue(swap.boxOf(x) != a);
        x.route = o.route;
        x.submitter = address(1);
        assertTrue(swap.boxOf(x) != a);
        x.submitter = o.submitter;
        assertEq(swap.boxOf(x), a);
    }

    // ------------------------------------------------------------------ fee plumbing

    function test_fee_owedWhenPlatformCanNotReceive_thenCollect() public {
        Toggle p = new Toggle();
        uint256 p0 = address(p).balance; // the fork may already hold dust at this address
        vm.prank(platform);
        swap.setPlatform(address(p));
        _buyBunker(1 ether);
        assertEq(swap.owed(), 0.005 ether, "kept for later");
        assertEq(address(swap).balance, 0.005 ether + stray);

        vm.expectRevert(BunkerSwap.PayFailed.selector);
        swap.collect();
        p.set(true);
        swap.collect();
        assertEq(address(p).balance - p0, 0.005 ether);
        assertEq(swap.owed(), 0);
        vm.expectRevert(BunkerSwap.NothingThere.selector);
        swap.collect();

        // owed fees are never handed to the next swapper
        p.set(false);
        _buyBunker(1 ether);
        uint256 bunkerBefore = VAULT.balanceOf(id, ETH);
        _buyBunker(1 ether);
        assertEq(VAULT.balanceOf(id, ETH), bunkerBefore - 1 ether);
        assertEq(swap.owed(), 0.01 ether);
    }

    function test_setPlatform_onlyPlatform() public {
        vm.expectRevert(BunkerSwap.NotPlatform.selector);
        swap.setPlatform(address(this));
        vm.prank(platform);
        vm.expectRevert(BunkerSwap.BadConfig.selector);
        swap.setPlatform(address(0));
        vm.prank(platform);
        swap.setPlatform(relayer);
        assertEq(swap.platform(), relayer);
    }

    function test_handBack_onlySelf() public {
        Route memory r = _bunkerRoute(true);
        BunkerSwap.Order memory o = _order(ETH, BUNKER, 1 ether, 1, 0, r);
        vm.expectRevert(BunkerSwap.NotSelf.selector);
        swap.handBack(o, address(this));
    }

    function testFuzz_buyThenSell_neverLeavesDust(uint256 ethIn, uint256 tip) public {
        ethIn = bound(ethIn, 0.001 ether, 5 ether);
        tip = bound(tip, 0, ethIn / 4);
        Route memory r = _bunkerRoute(true);
        BunkerSwap.Order memory o = _order(ETH, BUNKER, ethIn, 1, tip, r);
        _run(o, r, relayer);
        uint256 fee = (ethIn * FEE_BPS) / 10_000;
        assertEq(platform.balance, fee);
        assertEq(relayer.balance, tip);
        assertEq(VAULT.balanceOf(id, ETH), 10 ether - ethIn);
        _assertClean(o);

        uint256 held = VAULT.balanceOf(id, BUNKER);
        r = _bunkerRoute(false);
        o = _order(BUNKER, ETH, held, 1, 0, r);
        _run(o, r, relayer);
        assertEq(VAULT.balanceOf(id, BUNKER), 0);
        _assertClean(o);
    }
}
