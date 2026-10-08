// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BunkerVault} from "../src/BunkerVault.sol";
import {BunkerTripwire, IBunkerVault} from "../src/BunkerTripwire.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {Wots, FeeToken} from "./BunkerVault.t.sol";

/// Same contract, but the canary is a key the tests hold (private key 0xc0ffee), so `claim` can be exercised.
contract HeldCanaryTripwire is BunkerTripwire {
    constructor(IBunkerVault v) payable BunkerTripwire(v) {}

    function _canaryKey() internal pure override returns (uint256, uint256, uint256) {
        return (
            0x2a5bbcb0eede528e6abe5f2ec50ad7887eb5677af383a460b05ee23bf892dfe5,
            0x52c93747550eda8404c8b473786c00dfd8fd1ef4bc033f359ccf5b77bd656d21,
            0
        );
    }
}

/// USDT-style: no return values, and approve from non-zero to non-zero reverts.
contract UsdtLike {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
    }

    function approve(address s, uint256 v) external {
        require(v == 0 || allowance[msg.sender][s] == 0, "reset first");
        allowance[msg.sender][s] = v;
    }

    function transfer(address to, uint256 v) external {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
    }

    function transferFrom(address f, address to, uint256 v) external {
        allowance[f][msg.sender] -= v;
        balanceOf[f] -= v;
        balanceOf[to] += v;
    }
}

contract BrokenToken is MockERC20 {
    constructor() MockERC20("Broken", "BRK", 18) {}

    function transferFrom(address, address, uint256) external pure override returns (bool) {
        revert("frozen");
    }
}

contract GasBurnToken is MockERC20 {
    constructor() MockERC20("Burn", "BRN", 18) {}

    function transferFrom(address, address, uint256) external pure override returns (bool) {
        while (true) {}
        return true;
    }
}

contract ReentrantToken is MockERC20 {
    BunkerTripwire public tw;
    bool public reentered;

    constructor() MockERC20("Re", "RE", 18) {}

    function setTarget(BunkerTripwire t) external {
        tw = t;
    }

    function transferFrom(address f, address to, uint256 v) external override returns (bool) {
        address[] memory one = new address[](1);
        one[0] = f;
        try tw.escapeMany(one) {
            reentered = true;
        } catch {}
        try tw.moveOne(f, address(this), bytes32(uint256(1))) {
            reentered = true;
        } catch {}
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= v;
        return _t(f, to, v);
    }
}

contract BunkerTripwireTest is Test {
    uint256 constant CANARY_PK = 0xc0ffee;
    uint256 constant P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;
    uint256 constant SEED = 0xb0b;

    BunkerVault vault;
    BunkerTripwire real; // canary derived from the seed: nobody can sign
    HeldCanaryTripwire tw; // canary key held by the tests
    MockERC20 usdc;
    bytes32 bunker;
    address owner = makeAddr("tripwire-owner");
    address hunter = makeAddr("tripwire-hunter");

    event Escaped(address indexed owner, address indexed token, bytes32 indexed bunker, uint256 amount);
    event EscapeFailed(address indexed owner, address indexed token);

    function setUp() public {
        vault = new BunkerVault();
        real = new BunkerTripwire(IBunkerVault(address(vault)));
        tw = new HeldCanaryTripwire(IBunkerVault(address(vault)));
        usdc = new MockERC20("USD Coin", "USDC", 6);
        bunker = Wots.pk(SEED, 0);
        vault.depositETH{value: 1 wei}(bunker); // opens the bunker
        vm.deal(address(this), 100 ether);
    }

    // ------------------------------------------------------------------ helpers

    function _join(BunkerTripwire t, address who, address[] memory tokens) internal {
        vm.prank(who);
        t.register(bunker, tokens);
    }

    function _one(address a) internal pure returns (address[] memory l) {
        l = new address[](1);
        l[0] = a;
    }

    function _claimSig(BunkerTripwire t, address to) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        return vm.sign(CANARY_PK, t.claimDigest(to));
    }

    function _tripByClaim() internal {
        (uint8 v, bytes32 r, bytes32 s) = _claimSig(tw, hunter);
        tw.claim(hunter, v, r, s);
    }

    function _delegate(address who) internal {
        vm.etch(who, abi.encodePacked(hex"ef0100", address(0xdead))); // what EIP-7702 leaves at a delegated EOA
    }

    // ------------------------------------------------------------------ canary

    function test_canaryIsNothingUpMySleeve() public view {
        uint256 x = real.canaryX();
        uint256 y = real.canaryY();
        uint256 c = real.canaryCounter();
        assertEq(x, uint256(keccak256(abi.encodePacked(real.CANARY_SEED(), c))), "x from seed");
        assertEq(mulmod(y, y, P), addmod(mulmod(mulmod(x, x, P), x, P), 7, P), "on curve");
        assertEq(y & 1, 0, "even y");
        assertLt(x, P);
        for (uint256 i; i < c; ++i) {
            uint256 xi = uint256(keccak256(abi.encodePacked(real.CANARY_SEED(), i)));
            uint256 rhs = addmod(mulmod(mulmod(xi, xi, P), xi, P), 7, P);
            // Euler: rhs is a square iff rhs^((p-1)/2) == 1; earlier counters must not be
            assertTrue(xi >= P || _pow(rhs, (P - 1) / 2) != 1, "first valid counter");
        }
        assertEq(real.canary(), address(uint160(uint256(keccak256(abi.encodePacked(x, y))))));
        assertEq(real.canaryPublicKey(), abi.encodePacked(uint8(4), x, y));
        assertEq(real.canary().code.length, 0);
        assertFalse(real.isTripped());
    }

    function _pow(uint256 b, uint256 e) internal pure returns (uint256 r) {
        r = 1;
        while (e != 0) {
            if (e & 1 == 1) r = mulmod(r, b, P);
            b = mulmod(b, b, P);
            e >>= 1;
        }
    }

    function test_heldCanaryMatchesItsKey() public view {
        assertEq(tw.canary(), vm.addr(CANARY_PK));
    }

    // ------------------------------------------------------------------ bounty

    function test_fundAndReceive() public {
        tw.fund{value: 1 ether}();
        (bool ok,) = address(tw).call{value: 0.5 ether}("");
        assertTrue(ok);
        assertEq(address(tw).balance, 1.5 ether);
        BunkerTripwire seeded = new BunkerTripwire{value: 2 ether}(IBunkerVault(address(vault)));
        assertEq(address(seeded).balance, 2 ether);
    }

    function test_claimPaysWholeBountyAndTrips() public {
        tw.fund{value: 3 ether}();
        uint256 before = hunter.balance;
        _tripByClaim();
        assertEq(hunter.balance - before, 3 ether);
        assertEq(address(tw).balance, 0);
        assertEq(tw.claimedBy(), hunter);
        assertEq(tw.trippedAt(), block.timestamp);
        assertTrue(tw.isTripped());
        vm.expectRevert(BunkerTripwire.AlreadyTripped.selector);
        tw.fund{value: 1}();
    }

    function test_claimRejectsOtherKeys() public {
        tw.fund{value: 1 ether}();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xbad, tw.claimDigest(hunter));
        vm.expectRevert(BunkerTripwire.BadSignature.selector);
        tw.claim(hunter, v, r, s);
        // the real canary: no key can sign, so garbage never passes either
        vm.expectRevert(BunkerTripwire.BadSignature.selector);
        real.claim(hunter, 27, bytes32(uint256(1)), bytes32(uint256(2)));
    }

    function test_claimSignatureIsBoundToRecipient() public {
        tw.fund{value: 1 ether}();
        (uint8 v, bytes32 r, bytes32 s) = _claimSig(tw, hunter);
        vm.expectRevert(BunkerTripwire.BadSignature.selector);
        tw.claim(makeAddr("front-runner"), v, r, s); // copied from the mempool, different payee
        tw.claim(hunter, v, r, s);
        assertEq(hunter.balance, 1 ether);
    }

    function test_claimSignatureIsBoundToContractAndChain() public {
        HeldCanaryTripwire other = new HeldCanaryTripwire(IBunkerVault(address(vault)));
        other.fund{value: 1 ether}();
        (uint8 v, bytes32 r, bytes32 s) = _claimSig(tw, hunter);
        vm.expectRevert(BunkerTripwire.BadSignature.selector);
        other.claim(hunter, v, r, s);
        vm.chainId(5);
        vm.expectRevert(BunkerTripwire.BadSignature.selector);
        tw.claim(hunter, v, r, s);
    }

    function test_claimFailsWholeIfPayeeRejects() public {
        tw.fund{value: 1 ether}();
        address rejecter = address(new RejectEth());
        (uint8 v, bytes32 r, bytes32 s) = _claimSig(tw, rejecter);
        vm.expectRevert(BunkerTripwire.PayoutFailed.selector);
        tw.claim(rejecter, v, r, s);
        assertEq(tw.trippedAt(), 0, "no trip without payout");
    }

    // ------------------------------------------------------------------ trip by code

    function test_tripByDelegationCode() public {
        vm.expectRevert(BunkerTripwire.Armed.selector);
        real.trip();
        _delegate(real.canary());
        assertTrue(real.isTripped());
        real.trip();
        assertEq(real.trippedAt(), block.timestamp);
        vm.expectRevert(BunkerTripwire.AlreadyTripped.selector);
        real.trip();
    }

    function test_bountySurvivesCodeTripForTheKeyHolder() public {
        tw.fund{value: 1 ether}();
        _delegate(tw.canary());
        tw.trip();
        vm.etch(tw.canary(), ""); // tests only: let the held key sign normally again
        _tripByClaim();
        assertEq(hunter.balance, 1 ether);
    }

    // ------------------------------------------------------------------ membership

    function test_registerNeedsOpenBunker() public {
        vm.prank(owner);
        vm.expectRevert(BunkerTripwire.BunkerNotOpen.selector);
        tw.register(Wots.pk(SEED + 1, 0), _one(address(usdc)));
        vm.prank(owner);
        vm.expectRevert(BunkerTripwire.BunkerNotOpen.selector);
        tw.register(bytes32(0), _one(address(usdc)));
    }

    function test_registerChecksTokens() public {
        address[] memory bad = new address[](1);
        bad[0] = makeAddr("eoa-not-token");
        vm.startPrank(owner);
        vm.expectRevert(BunkerTripwire.BadToken.selector);
        tw.register(bunker, bad);
        bad[0] = address(vault);
        vm.expectRevert(BunkerTripwire.BadToken.selector);
        tw.register(bunker, bad);
        vm.expectRevert(BunkerTripwire.TooManyTokens.selector);
        tw.register(bunker, new address[](33));
        vm.stopPrank();
    }

    function test_registerListsOnceAndUpdates() public {
        _join(tw, owner, _one(address(usdc)));
        address[] memory two = new address[](2);
        two[0] = address(usdc);
        two[1] = address(new MockERC20("W", "W", 18));
        _join(tw, owner, two);
        assertEq(tw.memberCount(), 1);
        assertEq(tw.tokensOf(owner).length, 2);
        assertEq(tw.bunkerOf(owner), bunker);
        vm.prank(owner);
        tw.leave();
        assertEq(tw.bunkerOf(owner), 0);
        assertEq(tw.tokensOf(owner).length, 0);
        assertEq(tw.memberCount(), 1, "stays listed, escapes nothing");
    }

    // ------------------------------------------------------------------ escape

    function test_nothingMovesWhileArmed() public {
        usdc.mint(owner, 1000e6);
        vm.prank(owner);
        usdc.approve(address(tw), type(uint256).max);
        _join(tw, owner, _one(address(usdc)));
        vm.expectRevert(BunkerTripwire.Armed.selector);
        tw.escape(owner);
        vm.expectRevert(BunkerTripwire.Armed.selector);
        tw.escapeMany(_one(owner));
        vm.expectRevert(BunkerTripwire.OnlySelf.selector);
        tw.moveOne(owner, address(usdc), bunker);
        assertEq(usdc.balanceOf(owner), 1000e6);
    }

    function test_escapeMovesIntoBunker() public {
        usdc.mint(owner, 1000e6);
        vm.prank(owner);
        usdc.approve(address(tw), type(uint256).max);
        _join(tw, owner, _one(address(usdc)));
        _tripByClaim();

        vm.expectEmit(address(tw));
        emit Escaped(owner, address(usdc), bunker, 1000e6);
        vm.prank(makeAddr("anyone"));
        tw.escape(owner);
        assertEq(usdc.balanceOf(owner), 0);
        assertEq(vault.balanceOf(bunker, address(usdc)), 1000e6);
        assertEq(usdc.balanceOf(address(tw)), 0, "nothing left behind");
        assertEq(usdc.allowance(address(tw), address(vault)), 0);

        // later arrivals escape on the next call
        usdc.mint(owner, 5e6);
        tw.escape(owner);
        assertEq(vault.balanceOf(bunker, address(usdc)), 1005e6);
    }

    function test_escapeTripsByItselfWhenCanaryHasCode() public {
        usdc.mint(owner, 7e6);
        vm.prank(owner);
        usdc.approve(address(real), 7e6);
        _join(real, owner, _one(address(usdc)));
        _delegate(real.canary());
        real.escape(owner); // no separate trip() needed
        assertGt(real.trippedAt(), 0);
        assertEq(vault.balanceOf(bunker, address(usdc)), 7e6);
    }

    function testFuzz_escapeMovesMinOfBalanceAndAllowance(uint96 bal, uint96 allowed) public {
        usdc.mint(owner, bal);
        vm.prank(owner);
        usdc.approve(address(tw), allowed);
        _join(tw, owner, _one(address(usdc)));
        _tripByClaim();
        tw.escape(owner);
        uint256 moved = bal < allowed ? bal : allowed;
        assertEq(vault.balanceOf(bunker, address(usdc)), moved);
        assertEq(usdc.balanceOf(owner), uint256(bal) - moved);
    }

    function test_badTokensAreSkippedOthersMove() public {
        UsdtLike usdt = new UsdtLike();
        FeeToken fee = new FeeToken();
        BrokenToken broken = new BrokenToken();
        GasBurnToken burner = new GasBurnToken();
        usdt.mint(owner, 500e6);
        fee.mint(owner, 1000 ether);
        broken.mint(owner, 1 ether);
        burner.mint(owner, 1 ether);
        usdc.mint(owner, 42e6);

        vm.startPrank(owner);
        usdt.approve(address(tw), type(uint256).max);
        fee.approve(address(tw), type(uint256).max);
        broken.approve(address(tw), type(uint256).max);
        burner.approve(address(tw), type(uint256).max);
        usdc.approve(address(tw), type(uint256).max);
        vm.stopPrank();

        // leftover allowance to the vault, so the USDT-style token needs its approve reset path
        vm.prank(address(tw));
        usdt.approve(address(vault), 1);

        address[] memory list = new address[](5);
        list[0] = address(burner);
        list[1] = address(usdt);
        list[2] = address(broken);
        list[3] = address(fee);
        list[4] = address(usdc);
        _join(tw, owner, list);
        _tripByClaim();

        vm.expectEmit(address(tw));
        emit EscapeFailed(owner, address(burner));
        tw.escape{gas: 8_000_000}(owner);

        assertEq(vault.balanceOf(bunker, address(usdt)), 500e6, "usdt-style");
        assertEq(usdt.balanceOf(owner), 0);
        assertEq(broken.balanceOf(owner), 1 ether, "broken stays home");
        assertEq(burner.balanceOf(owner), 1 ether, "gas burner stays home");
        // 10% fee on owner->tripwire and again on tripwire->vault
        assertEq(vault.balanceOf(bunker, address(fee)), 810 ether, "fee token credited what arrived");
        assertEq(fee.balanceOf(owner), 0);
        assertEq(vault.balanceOf(bunker, address(usdc)), 42e6);
    }

    function test_lowGasCallRevertsInsteadOfSkipping() public {
        usdc.mint(owner, 1e6);
        vm.prank(owner);
        usdc.approve(address(tw), 1e6);
        _join(tw, owner, _one(address(usdc)));
        _tripByClaim();
        vm.expectRevert(BunkerTripwire.OutOfGas.selector);
        tw.escape{gas: 300_000}(owner);
        assertEq(usdc.balanceOf(owner), 1e6);
    }

    function test_tokenCanNotReenter() public {
        ReentrantToken re = new ReentrantToken();
        re.setTarget(tw);
        re.mint(owner, 9 ether);
        vm.prank(owner);
        re.approve(address(tw), type(uint256).max);
        _join(tw, owner, _one(address(re)));
        _tripByClaim();
        tw.escape(owner);
        assertFalse(re.reentered());
        assertEq(vault.balanceOf(bunker, address(re)), 9 ether);
    }

    function test_leaveMeansNothingMoves() public {
        usdc.mint(owner, 1e6);
        vm.prank(owner);
        usdc.approve(address(tw), 1e6);
        _join(tw, owner, _one(address(usdc)));
        vm.prank(owner);
        tw.leave();
        _tripByClaim();
        tw.escape(owner);
        assertEq(usdc.balanceOf(owner), 1e6);
    }

    function test_escapeManyAndPaging() public {
        address[] memory owners = new address[](12);
        for (uint256 i; i < owners.length; ++i) {
            owners[i] = makeAddr(string(abi.encodePacked("tw-member-", vm.toString(i))));
            usdc.mint(owners[i], (i + 1) * 1e6);
            vm.prank(owners[i]);
            usdc.approve(address(tw), type(uint256).max);
            _join(tw, owners[i], _one(address(usdc)));
        }
        assertEq(tw.memberCount(), 12);
        assertEq(tw.members(10, 5).length, 2);
        assertEq(tw.members(12, 5).length, 0);
        assertEq(tw.members(0, 5)[4], owners[4]);
        _tripByClaim();
        tw.escapeMany(tw.members(0, 12));
        assertEq(vault.balanceOf(bunker, address(usdc)), 78e6); // 1+2+...+12
    }

    /// The whole point: after the escape, only the hash-based key gets the tokens out.
    function test_escapedTokensWithdrawWithWotsKey() public {
        usdc.mint(owner, 250e6);
        vm.prank(owner);
        usdc.approve(address(tw), type(uint256).max);
        _join(tw, owner, _one(address(usdc)));
        _tripByClaim();
        tw.escape(owner);

        address fresh = makeAddr("never-signed");
        BunkerVault.Transfer[] memory t = new BunkerVault.Transfer[](1);
        t[0] = BunkerVault.Transfer(address(usdc), fresh, 250e6);
        bytes32 next = Wots.pk(SEED, 1);
        bytes32 d = vault.digest(bunker, t, address(0), 0, next);
        vault.execute(bunker, t, address(0), 0, next, Wots.sign(SEED, 0, d));
        assertEq(usdc.balanceOf(fresh), 250e6);
    }
}

contract RejectEth {
    receive() external payable {
        revert("no");
    }
}
