// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BunkerLaunchpad, IPoolManager, IBunkerVault, PoolKey, SwapParams} from "../src/BunkerLaunchpad.sol";
import {BunkerLaunchToken} from "../src/BunkerLaunchToken.sol";

/// The live BunkerVault on Ethereum mainnet (0x39C7…2727): dev bags and creator fees can land in a bunker.
interface ILiveVault is IBunkerVault {
    function balanceOf(bytes32 id, address token) external view returns (uint256);
}

interface IStateView {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
    function getLiquidity(bytes32 poolId) external view returns (uint128);
}

/// A third-party swapper that talks to the PoolManager directly (stands in for any v4 router).
contract OtherRouter {
    IPoolManager immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function buy(PoolKey calldata key, uint256 amountIn) external payable {
        pm.unlock(abi.encode(key, amountIn, msg.sender));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, uint256 amountIn, address to) = abi.decode(data, (PoolKey, uint256, address));
        int256 d = pm.swap(key, SwapParams(true, -int256(amountIn), 4_295_128_740), "");
        pm.settle{value: uint256(-int256(int128(d >> 128)))}();
        pm.take(key.currency1, to, uint256(int256(int128(d))));
        return "";
    }
}

contract RevertingReceiver {
    receive() external payable {
        revert("no");
    }
}

/// Mainnet fork: real Uniswap v4 PoolManager and the real BunkerVault, signatures from the browser signer
/// (scripts/pq-cli.mjs via ffi). Run: forge test --match-contract BunkerLaunchpadForkTest (ETH_RPC_URL overrides the RPC)
contract BunkerLaunchpadForkTest is Test {
    IPoolManager constant PM = IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90);
    IStateView constant STATE_VIEW = IStateView(0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227);
    // lowest 14 bits == 0x2000: the BEFORE_INITIALIZE hook flag and nothing else
    address constant LAUNCHPAD_AT = 0x00000000000000000000000000000000FA112000;

    // node scripts/v4math.mjs 2  (start FDV ~2.02 ETH)
    int24 constant TICK_UPPER = 200_200;
    uint160 constant START_SQRT_PRICE = 1_761_773_193_750_706_363_641_693_178_420_302;
    uint128 constant LIQUIDITY = 44_970_693_614_421_769_510_836;

    string constant ENTROPY = "0x2222222222222222222222222222222222222222222222222222222222222222";
    string constant OTHER_ENTROPY = "0x3333333333333333333333333333333333333333333333333333333333333333";

    BunkerLaunchpad lp;
    ILiveVault constant vault = ILiveVault(0x39C71b635409b1f98dc632e08d3B29515ddb2727);
    address creator = makeAddr("creator");
    address platform = makeAddr("platform");
    address trader = makeAddr("trader");
    bytes32 seed;
    bytes32 root;
    bytes32 id;

    function setUp() public {
        vm.createSelectFork(vm.envOr("ETH_RPC_URL", string("https://ethereum-rpc.publicnode.com")));
        assertGt(address(vault).code.length, 0, "live BunkerVault");
        deployCodeTo(
            "BunkerLaunchpad.sol:BunkerLaunchpad",
            abi.encode(PM, IBunkerVault(address(vault)), platform, START_SQRT_PRICE, TICK_UPPER, LIQUIDITY),
            LAUNCHPAD_AT
        );
        lp = BunkerLaunchpad(payable(LAUNCHPAD_AT));
        (seed, root) = _identity(ENTROPY);
        id = lp.identityOf(seed, root);
        vm.deal(creator, 100 ether);
        vm.deal(trader, 100 ether);
    }

    // ---------------------------------------------------------------- helpers

    function _identity(string memory entropy) internal returns (bytes32 s, bytes32 r) {
        string[] memory cmd = new string[](4);
        cmd[0] = "node";
        cmd[1] = "../scripts/pq-cli.mjs";
        cmd[2] = "identity";
        cmd[3] = entropy;
        (s, r) = abi.decode(vm.ffi(cmd), (bytes32, bytes32));
    }

    function _sign(string memory entropy, uint32 leaf, bytes32 digest) internal returns (BunkerLaunchpad.PQSig memory) {
        string[] memory cmd = new string[](6);
        cmd[0] = "node";
        cmd[1] = "../scripts/pq-cli.mjs";
        cmd[2] = "sign";
        cmd[3] = entropy;
        cmd[4] = vm.toString(uint256(leaf));
        cmd[5] = vm.toString(digest);
        return abi.decode(vm.ffi(cmd), (BunkerLaunchpad.PQSig));
    }

    function _params(string memory name) internal view returns (BunkerLaunchpad.LaunchParams memory p) {
        p.name = name;
        p.symbol = "BNKR";
        p.meta = '{"description":"launched from a bunker","x":"https://x.com/example"}';
        p.image = hex"52494646000000005745425056503820"; // a few bytes standing in for a webp
        p.devTo = creator;
        p.feeTo = creator;
    }

    function _launch(BunkerLaunchpad.LaunchParams memory p, uint32 leaf, uint256 devBuy) internal returns (address token) {
        bytes32 d = this.digestOf(id, leaf, creator, devBuy, p);
        BunkerLaunchpad.PQSig memory s = _sign(ENTROPY, leaf, d);
        vm.prank(creator);
        token = lp.launch{value: devBuy}(p, s);
    }

    /// external so the memory params become calldata for launchDigest
    function digestOf(bytes32 i, uint32 leaf, address c, uint256 v, BunkerLaunchpad.LaunchParams calldata p)
        external
        view
        returns (bytes32)
    {
        return lp.launchDigest(i, leaf, c, v, p);
    }

    // ---------------------------------------------------------------- launch

    function test_launchCreatesLockedPoolAtTheStartPrice() public {
        BunkerLaunchpad.LaunchParams memory p = _params("Post Quantum");
        address predicted = lp.tokenAddress(id, 7, p.name, p.symbol);
        uint256 g = gasleft();
        address token = _launch(p, 7, 0);
        emit log_named_uint("launch gas (no dev buy, incl. ffi-free work)", g - gasleft());
        assertEq(token, predicted, "CREATE2 address");

        BunkerLaunchToken t = BunkerLaunchToken(token);
        assertEq(t.name(), "Post Quantum");
        assertEq(t.totalSupply(), 1_000_000_000e18);
        assertGt(t.balanceOf(address(PM)), 999_999_999e18, "whole supply in the pool");
        assertLt(t.balanceOf(0x000000000000000000000000000000000000dEaD), 1e6, "only rounding dust burned");
        assertEq(t.balanceOf(address(lp)), 0);

        bytes32 pid = lp.poolId(token);
        (uint160 sqrtP, int24 tick,, uint24 fee) = STATE_VIEW.getSlot0(pid);
        assertEq(sqrtP, START_SQRT_PRICE);
        assertEq(tick, TICK_UPPER);
        assertEq(fee, 10_000);

        (bytes32 cid, address c, uint32 leaf, uint64 at,, uint64 blk,) = lp.coins(token);
        assertEq(blk, block.number);
        assertEq(cid, id);
        assertEq(c, creator);
        assertEq(leaf, 7);
        assertEq(at, block.timestamp);
        assertTrue(lp.isLeafUsed(id, 7));
        assertFalse(lp.isLeafUsed(id, 8));
        assertEq(lp.coinsCount(), 1);
        (uint64 firstSeen, uint32 launches) = lp.identities(id);
        assertEq(firstSeen, block.timestamp);
        assertEq(launches, 1);
    }

    function test_devBuyToWalletInTheSameTransaction() public {
        address token = _launch(_params("Dev Buy"), 1, 1 ether);
        uint256 got = BunkerLaunchToken(token).balanceOf(creator);
        emit log_named_uint("1 ETH dev buy, % of supply x100", got * 10_000 / 1_000_000_000e18);
        // virtual reserves ~2.02 ETH: 1 ETH buys ~1/3 of the supply (minus the 1% fee)
        assertGt(got, 320_000_000e18);
        assertLt(got, 340_000_000e18);
    }

    function test_devBuyIntoThePostQuantumVault() public {
        BunkerLaunchpad.LaunchParams memory p = _params("Vault Bag");
        p.devTo = address(0);
        p.devVault = keccak256("creator vault account");
        address token = _launch(p, 2, 0.5 ether);
        assertEq(BunkerLaunchToken(token).balanceOf(creator), 0, "nothing under an ECDSA key");
        uint256 inVault = vault.balanceOf(p.devVault, token);
        assertGt(inVault, 190_000_000e18);
        assertGe(BunkerLaunchToken(token).balanceOf(address(vault)), inVault);
    }

    function test_eachOneTimeKeyLaunchesOnce() public {
        _launch(_params("First"), 3, 0);
        BunkerLaunchpad.LaunchParams memory p = _params("Second");
        bytes32 d = this.digestOf(id, 3, creator, 0, p);
        BunkerLaunchpad.PQSig memory s = _sign(ENTROPY, 3, d); // valid signature, but leaf 3 is burned
        vm.prank(creator);
        vm.expectRevert(bytes("leaf used"));
        lp.launch(p, s);
    }

    function test_signatureCoversEveryField() public {
        BunkerLaunchpad.LaunchParams memory p = _params("Signed");
        BunkerLaunchpad.PQSig memory s = _sign(ENTROPY, 4, this.digestOf(id, 4, creator, 0, p));

        BunkerLaunchpad.LaunchParams memory q = _params("Signed");
        q.symbol = "BNKS";
        vm.prank(creator);
        vm.expectRevert(bytes("signature"));
        lp.launch(q, s);

        q = _params("Signed");
        q.image = hex"00";
        vm.prank(creator);
        vm.expectRevert(bytes("signature"));
        lp.launch(q, s);

        q = _params("Signed");
        q.feeTo = trader;
        vm.prank(creator);
        vm.expectRevert(bytes("signature"));
        lp.launch(q, s);

        vm.prank(creator); // dev buy amount is signed too
        vm.expectRevert(bytes("signature"));
        lp.launch{value: 1 wei}(p, s);

        vm.prank(trader); // a copied transaction from another wallet does not verify
        vm.expectRevert(bytes("signature"));
        lp.launch(p, s);

        (bytes32 mySeed, bytes32 myRoot) = (s.seed, s.root); // someone else's identity can't claim it either
        (s.seed, s.root) = _identity(OTHER_ENTROPY);
        vm.prank(creator);
        vm.expectRevert(bytes("signature"));
        lp.launch(p, s);
        (s.seed, s.root) = (mySeed, myRoot);

        vm.prank(creator);
        lp.launch(p, s); // the untouched launch goes through
    }

    function test_nobodyCanCreateTheCoinPoolFirst() public {
        BunkerLaunchpad.LaunchParams memory p = _params("Front Run");
        address predicted = lp.tokenAddress(id, 5, p.name, p.symbol);
        PoolKey memory key = lp.poolKey(predicted);
        vm.prank(trader);
        vm.expectRevert(); // the hook refuses (wrapped by the PoolManager)
        PM.initialize(key, START_SQRT_PRICE / 2);
        _launch(p, 5, 0); // and the real launch still works
    }

    function test_inputLimits() public {
        BunkerLaunchpad.LaunchParams memory p = _params("This name is far too long for a coin ok");
        BunkerLaunchpad.PQSig memory s;
        vm.expectRevert(bytes("name"));
        lp.launch(p, s);
        p = _params("Ok");
        p.symbol = "";
        vm.expectRevert(bytes("symbol"));
        lp.launch(p, s);
        p = _params("Ok");
        p.image = new bytes(24_577);
        vm.expectRevert(bytes("image"));
        lp.launch(p, s);
        p = _params("Ok");
        p.feeTo = address(0);
        vm.expectRevert(bytes("feeTo"));
        lp.launch(p, s);
        p = _params("Ok");
        p.devTo = address(0);
        vm.expectRevert(bytes("devTo"));
        lp.launch{value: 1}(p, s);
    }

    // ---------------------------------------------------------------- trading + fees

    function test_buySellAndAnyRouter() public {
        address token = _launch(_params("Tradeable"), 10, 0);
        vm.startPrank(trader);
        uint256 got = lp.buy{value: 0.2 ether}(token, 1, trader, block.timestamp);
        assertEq(BunkerLaunchToken(token).balanceOf(trader), got);
        vm.expectRevert(bytes("slippage"));
        lp.buy{value: 0.1 ether}(token, type(uint256).max, trader, block.timestamp);

        BunkerLaunchToken(token).approve(address(lp), got / 2);
        uint256 before = trader.balance;
        uint256 eth = lp.sell(token, got / 2, 1, trader, block.timestamp);
        assertEq(trader.balance - before, eth);
        assertGt(eth, 0.09 ether);

        OtherRouter r = new OtherRouter(PM);
        r.buy{value: 0.1 ether}(lp.poolKey(token), 0.1 ether);
        assertGt(BunkerLaunchToken(token).balanceOf(trader), got / 2);
        vm.stopPrank();
    }

    function test_feesSplitFiftyFifty() public {
        address token = _launch(_params("Fees"), 11, 0);
        vm.startPrank(trader);
        uint256 got = lp.buy{value: 2 ether}(token, 1, trader, block.timestamp);
        BunkerLaunchToken(token).approve(address(lp), got);
        lp.sell(token, got / 2, 1, trader, block.timestamp);
        vm.stopPrank();

        uint256 c0 = creator.balance;
        uint256 p0 = platform.balance;
        (uint256 eth, uint256 tokens) = lp.collect(token);
        emit log_named_uint("fees ETH", eth);
        emit log_named_uint("fees tokens", tokens);
        assertApproxEqAbs(eth, 0.02 ether, 0.0001 ether, "1% of 2 ETH bought");
        assertGt(tokens, 0);
        assertEq(creator.balance - c0, eth / 2);
        assertEq(platform.balance - p0, eth - eth / 2);
        assertEq(BunkerLaunchToken(token).balanceOf(platform), tokens - tokens / 2);
        assertEq(address(lp).balance, 0);
        assertEq(BunkerLaunchToken(token).balanceOf(address(lp)), 0);

        (uint256 eth2,) = lp.collect(token); // nothing new
        assertEq(eth2, 0);
    }

    function test_onlyThePostQuantumKeyMovesCreatorFees() public {
        address token = _launch(_params("Fee Control"), 12, 0);
        address newTo = makeAddr("new fee wallet");
        bytes32 d = lp.feeDigest(token, id, 13, newTo, 0);
        BunkerLaunchpad.PQSig memory s = _sign(ENTROPY, 13, d);

        BunkerLaunchpad.PQSig memory other = _sign(OTHER_ENTROPY, 13, d);
        vm.expectRevert(bytes("identity"));
        lp.setFeeTo(token, newTo, 0, other);

        vm.prank(trader); // submitter does not matter, only the signature
        lp.setFeeTo(token, newTo, 0, s);
        (,,,, address feeTo,,) = lp.coins(token);
        assertEq(feeTo, newTo);

        vm.expectRevert(bytes("leaf used"));
        lp.setFeeTo(token, newTo, 0, s);

        vm.prank(trader);
        lp.buy{value: 1 ether}(token, 1, trader, block.timestamp);
        uint256 b = newTo.balance;
        (uint256 eth,) = lp.collect(token);
        assertEq(newTo.balance - b, eth / 2);
    }

    function test_creatorFeesIntoTheVault() public {
        BunkerLaunchpad.LaunchParams memory p = _params("Vault Fees");
        p.feeTo = address(0);
        p.feeVault = keccak256("fee vault");
        address token = _launch(p, 14, 0);
        vm.prank(trader);
        lp.buy{value: 1 ether}(token, 1, trader, block.timestamp);
        (uint256 eth,) = lp.collect(token);
        assertEq(vault.balanceOf(p.feeVault, address(0)), eth / 2);
        assertEq(lp.pendingVault(p.feeVault, address(0)), 0, "deposit went through");
    }

    function test_revertingFeeWalletIsCreditedNotStuck() public {
        BunkerLaunchpad.LaunchParams memory p = _params("Stubborn");
        address bad = address(new RevertingReceiver());
        p.feeTo = bad;
        address token = _launch(p, 15, 0);
        vm.prank(trader);
        lp.buy{value: 1 ether}(token, 1, trader, block.timestamp);
        (uint256 eth,) = lp.collect(token); // does not revert
        assertEq(lp.claimableETH(bad), eth / 2);
        vm.expectRevert(bytes("send"));
        lp.claim(bad);
    }

    function test_platformCanOnlyMoveItsOwnHalf() public {
        vm.expectRevert(bytes("platform"));
        lp.setPlatform(trader);
        vm.prank(platform);
        lp.setPlatform(trader);
        assertEq(lp.platform(), trader);
    }
}
