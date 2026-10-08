// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {BunkerVault} from "../src/BunkerVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// WOTS signer used by the tests (same scheme as site/src/lib/wots.js; secrets derived differently, which is fine:
/// only the chain function, digit split and public-key hash must match the contract).
library Wots {
    function sk(uint256 seed, uint256 k, uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(seed, uint32(k), uint8(i)));
    }

    function step(bytes32 x, uint256 i, uint256 from, uint256 to) internal pure returns (bytes32) {
        for (uint256 j = from; j < to; ++j) {
            x = keccak256(abi.encodePacked(x, uint8(i), uint8(j)));
        }
        return x;
    }

    function digits(bytes32 d) internal pure returns (uint256[67] memory out) {
        uint256 csum;
        for (uint256 i; i < 64; ++i) {
            out[i] = (uint256(d) >> (252 - 4 * i)) & 0xf;
            csum += 15 - out[i];
        }
        out[64] = (csum >> 8) & 0xf;
        out[65] = (csum >> 4) & 0xf;
        out[66] = csum & 0xf;
    }

    function pk(uint256 seed, uint256 k) internal pure returns (bytes32) {
        bytes32[67] memory ends;
        for (uint256 i; i < 67; ++i) {
            ends[i] = step(sk(seed, k, i), i, 0, 15);
        }
        return keccak256(abi.encodePacked(ends));
    }

    function sign(uint256 seed, uint256 k, bytes32 d) internal pure returns (bytes32[67] memory s) {
        uint256[67] memory dg = digits(d);
        for (uint256 i; i < 67; ++i) {
            s[i] = step(sk(seed, k, i), i, 0, dg[i]);
        }
    }
}

contract NoReturnToken {
    // USDT-style: transfer/transferFrom return nothing
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
    }

    function approve(address s, uint256 v) external {
        allowance[msg.sender][s] = v;
    }

    function transfer(address to, uint256 v) external {
        require(balanceOf[msg.sender] >= v);
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
    }

    function transferFrom(address f, address to, uint256 v) external {
        require(allowance[f][msg.sender] >= v && balanceOf[f] >= v);
        allowance[f][msg.sender] -= v;
        balanceOf[f] -= v;
        balanceOf[to] += v;
    }
}

contract FeeToken {
    // 10% fee on every transfer; recipient can be blocked
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
    }

    function block_(address a, bool b) external {
        blocked[a] = b;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        return _t(msg.sender, to, v);
    }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        allowance[f][msg.sender] -= v;
        return _t(f, to, v);
    }

    function _t(address f, address to, uint256 v) internal returns (bool) {
        require(!blocked[to], "blocked");
        balanceOf[f] -= v;
        balanceOf[to] += v - v / 10;
        return true;
    }
}

contract Rejecter {
    receive() external payable {
        revert("no");
    }
}

contract GasBurner {
    receive() external payable {
        while (true) {}
    }
}

contract Picky {
    uint256[] private sink;

    receive() external payable {
        for (uint256 i; i < 1; ++i) sink.push(i); // one fresh SSTORE: needs ~22k+ gas
    }
}

contract Reenterer {
    BunkerVault vault;
    bytes public lastError;

    constructor(BunkerVault v) {
        vault = v;
    }

    receive() external payable {
        try vault.depositETH{value: msg.value}(bytes32(uint256(7))) {} catch (bytes memory e) {
            lastError = e;
            revert("reentry blocked");
        }
    }
}

contract BunkerVaultTest is Test {
    BunkerVault vault;
    MockERC20 bunker;
    uint256 constant SEED = 0xb0b;
    bytes32 id;
    address alice = makeAddr("alice");
    address relayer = makeAddr("relayer");

    function setUp() public {
        vault = new BunkerVault();
        bunker = new MockERC20("Bunker Mode", "BUNKER", 18);
        bunker.mint(address(this), 1e27);
        id = Wots.pk(SEED, 0);
        vm.deal(address(this), 100 ether);
    }

    function _one(address token, address to, uint256 amount) internal pure returns (BunkerVault.Transfer[] memory t) {
        t = new BunkerVault.Transfer[](1);
        t[0] = BunkerVault.Transfer(token, to, amount);
    }

    function _exec(BunkerVault.Transfer[] memory t, address rel, uint256 fee) internal returns (bytes32[67] memory s) {
        (, uint64 nonce) = vault.accounts(id);
        bytes32 next = Wots.pk(SEED, nonce + 1);
        bytes32 d = vault.digest(id, t, rel, fee, next);
        s = Wots.sign(SEED, nonce, d);
        vault.execute(id, t, rel, fee, next, s);
    }

    // ------------------------------------------------------------------ open + deposit

    function test_open_on_first_deposit() public {
        vault.depositETH{value: 1 ether}(id);
        (bytes32 key, uint64 nonce) = vault.accounts(id);
        assertEq(key, id);
        assertEq(nonce, 0);
        assertEq(vault.balanceOf(id, address(0)), 1 ether);
        vault.depositETH{value: 1 ether}(id); // second deposit does not reset anything
        assertEq(vault.balanceOf(id, address(0)), 2 ether);
    }

    function test_plain_eth_rejected() public {
        (bool ok,) = address(vault).call{value: 1}("");
        assertFalse(ok);
    }

    function test_zero_deposit_rejected() public {
        vm.expectRevert(BunkerVault.NothingReceived.selector);
        vault.depositETH{value: 0}(id);
    }

    function test_deposit_token_credits_received_amount() public {
        FeeToken ft = new FeeToken();
        ft.mint(address(this), 1000);
        ft.approve(address(vault), 1000);
        vault.deposit(id, address(ft), 1000);
        assertEq(vault.balanceOf(id, address(ft)), 900); // 10% fee
    }

    function test_deposit_rejects_codeless_token() public {
        vm.expectRevert(BunkerVault.BadTransfer.selector);
        vault.deposit(id, alice, 1);
    }

    // ------------------------------------------------------------------ execute

    function test_withdraw_eth_and_rotate() public {
        vault.depositETH{value: 3 ether}(id);
        _exec(_one(address(0), alice, 1 ether), address(0), 0);
        assertEq(alice.balance, 1 ether);
        assertEq(vault.balanceOf(id, address(0)), 2 ether);
        (bytes32 key, uint64 nonce) = vault.accounts(id);
        assertEq(key, Wots.pk(SEED, 1));
        assertEq(nonce, 1);
        assertTrue(vault.spentKey(id));
        // the next key works
        _exec(_one(address(0), alice, 2 ether), address(0), 0);
        assertEq(alice.balance, 3 ether);
        (key, nonce) = vault.accounts(id);
        assertEq(key, Wots.pk(SEED, 2));
        assertEq(nonce, 2);
    }

    function test_batch_sweep_eth_and_tokens() public {
        vault.depositETH{value: 1 ether}(id);
        bunker.approve(address(vault), 500e18);
        vault.deposit(id, address(bunker), 500e18);
        NoReturnToken usdt = new NoReturnToken();
        usdt.mint(address(this), 77);
        usdt.approve(address(vault), 77);
        vault.deposit(id, address(usdt), 77);

        BunkerVault.Transfer[] memory t = new BunkerVault.Transfer[](3);
        t[0] = BunkerVault.Transfer(address(bunker), alice, 500e18);
        t[1] = BunkerVault.Transfer(address(usdt), alice, 77);
        t[2] = BunkerVault.Transfer(address(0), alice, 1 ether);
        uint256 g = gasleft();
        _exec(t, address(0), 0);
        console2.log("execute (3 transfers) gas incl. signing in test", g - gasleft());
        assertEq(bunker.balanceOf(alice), 500e18);
        assertEq(usdt.balanceOf(alice), 77);
        assertEq(alice.balance, 1 ether);
    }

    function test_gas_execute_only() public {
        vault.depositETH{value: 1 ether}(id);
        BunkerVault.Transfer[] memory t = _one(address(0), alice, 1 ether);
        bytes32 next = Wots.pk(SEED, 1);
        bytes32 d = vault.digest(id, t, address(0), 0, next);
        bytes32[67] memory s = Wots.sign(SEED, 0, d);
        uint256 g = gasleft();
        vault.execute(id, t, address(0), 0, next, s);
        console2.log("execute (1 ETH transfer) gas", g - gasleft());
        g = gasleft();
        vault.wotsPublicKey(d, s);
        console2.log("wotsPublicKey gas", g - gasleft());
    }

    function test_bad_signature_reverts() public {
        vault.depositETH{value: 1 ether}(id);
        BunkerVault.Transfer[] memory t = _one(address(0), alice, 1 ether);
        bytes32 next = Wots.pk(SEED, 1);
        bytes32[67] memory s = Wots.sign(SEED, 0, vault.digest(id, t, address(0), 0, next));
        for (uint256 i; i < 67; i += 11) {
            bytes32[67] memory bad = s;
            bad[i] = bytes32(uint256(bad[i]) ^ 1);
            vm.expectRevert(BunkerVault.BadSignature.selector);
            vault.execute(id, t, address(0), 0, next, bad);
        }
        // a signature by a different seed
        bytes32[67] memory other = Wots.sign(SEED + 1, 0, vault.digest(id, t, address(0), 0, next));
        vm.expectRevert(BunkerVault.BadSignature.selector);
        vault.execute(id, t, address(0), 0, next, other);
    }

    function test_every_field_is_signed() public {
        vault.depositETH{value: 2 ether}(id);
        BunkerVault.Transfer[] memory t = _one(address(0), alice, 1 ether);
        bytes32 next = Wots.pk(SEED, 1);
        bytes32[67] memory s = Wots.sign(SEED, 0, vault.digest(id, t, address(0), 0, next));

        vm.expectRevert(BunkerVault.BadSignature.selector); // different recipient
        vault.execute(id, _one(address(0), relayer, 1 ether), address(0), 0, next, s);
        vm.expectRevert(BunkerVault.BadSignature.selector); // different amount
        vault.execute(id, _one(address(0), alice, 2 ether), address(0), 0, next, s);
        vm.expectRevert(BunkerVault.BadSignature.selector); // different token
        vault.execute(id, _one(address(bunker), alice, 1 ether), address(0), 0, next, s);
        vm.expectRevert(BunkerVault.BadSignature.selector); // added fee
        vault.execute(id, t, address(0), 1, next, s);
        vm.expectRevert(BunkerVault.BadSignature.selector); // different next key
        vault.execute(id, t, address(0), 0, Wots.pk(SEED, 9), s);
        vm.prank(relayer);
        vm.expectRevert(BunkerVault.BadSignature.selector); // added relayer
        vault.execute(id, t, relayer, 0, next, s);

        vault.execute(id, t, address(0), 0, next, s); // the real one still works
        assertEq(alice.balance, 1 ether);
    }

    function test_replay_rejected() public {
        vault.depositETH{value: 2 ether}(id);
        BunkerVault.Transfer[] memory t = _one(address(0), alice, 1 ether);
        bytes32 next = Wots.pk(SEED, 1);
        bytes32[67] memory s = Wots.sign(SEED, 0, vault.digest(id, t, address(0), 0, next));
        vault.execute(id, t, address(0), 0, next, s);
        vm.expectRevert(BunkerVault.BadNextKey.selector); // next == current key now
        vault.execute(id, t, address(0), 0, next, s);
        vm.expectRevert(BunkerVault.BadSignature.selector); // fresh next key, old signature
        vault.execute(id, t, address(0), 0, Wots.pk(SEED, 2), s);
    }

    function test_cross_chain_and_cross_vault_replay_rejected() public {
        vault.depositETH{value: 1 ether}(id);
        BunkerVault vault2 = new BunkerVault();
        vault2.depositETH{value: 1 ether}(id);
        BunkerVault.Transfer[] memory t = _one(address(0), alice, 1 ether);
        bytes32 next = Wots.pk(SEED, 1);
        bytes32[67] memory s = Wots.sign(SEED, 0, vault.digest(id, t, address(0), 0, next));
        vm.expectRevert(BunkerVault.BadSignature.selector);
        vault2.execute(id, t, address(0), 0, next, s);
        uint256 chain = block.chainid;
        vm.chainId(8453);
        vm.expectRevert(BunkerVault.BadSignature.selector);
        vault.execute(id, t, address(0), 0, next, s);
        vm.chainId(chain);
        vault.execute(id, t, address(0), 0, next, s);
    }

    function test_next_key_rules() public {
        vault.depositETH{value: 3 ether}(id);
        BunkerVault.Transfer[] memory t = _one(address(0), alice, 1 ether);
        bytes32[67] memory s;
        vm.expectRevert(BunkerVault.BadNextKey.selector);
        vault.execute(id, t, address(0), 0, bytes32(0), s);
        vm.expectRevert(BunkerVault.BadNextKey.selector);
        vault.execute(id, t, address(0), 0, id, s);
        _exec(t, address(0), 0); // key 0 is now spent
        // rotating back to the spent key 0 is refused even with a valid signature by key 1
        bytes32 d = vault.digest(id, t, address(0), 0, id);
        s = Wots.sign(SEED, 1, d);
        vm.expectRevert(BunkerVault.BadNextKey.selector);
        vault.execute(id, t, address(0), 0, id, s);
        // a spent key can not be opened as a new account either
        _exec(t, address(0), 0); // key 1 is now spent
        assertTrue(vault.spentKey(Wots.pk(SEED, 1)));
        vm.expectRevert(BunkerVault.BadNextKey.selector);
        vault.depositETH{value: 1}(Wots.pk(SEED, 1));
    }

    function test_unknown_account() public {
        BunkerVault.Transfer[] memory t = _one(address(0), alice, 1);
        bytes32[67] memory s;
        vm.expectRevert(BunkerVault.UnknownAccount.selector);
        vault.execute(id, t, address(0), 0, Wots.pk(SEED, 1), s);
    }

    function test_insufficient_and_bad_transfers() public {
        vault.depositETH{value: 1 ether}(id);
        BunkerVault.Transfer[] memory t = _one(address(0), alice, 2 ether);
        bytes32 next = Wots.pk(SEED, 1);
        bytes32[67] memory s = Wots.sign(SEED, 0, vault.digest(id, t, address(0), 0, next));
        vm.expectRevert(abi.encodeWithSelector(BunkerVault.Insufficient.selector, address(0)));
        vault.execute(id, t, address(0), 0, next, s);

        t = _one(address(0), address(vault), 1);
        s = Wots.sign(SEED, 0, vault.digest(id, t, address(0), 0, next));
        vm.expectRevert(BunkerVault.BadTransfer.selector);
        vault.execute(id, t, address(0), 0, next, s);

        t = _one(address(0), address(0), 1);
        s = Wots.sign(SEED, 0, vault.digest(id, t, address(0), 0, next));
        vm.expectRevert(BunkerVault.BadTransfer.selector);
        vault.execute(id, t, address(0), 0, next, s);
    }

    function test_relayer_fee_and_binding() public {
        vault.depositETH{value: 1 ether}(id);
        BunkerVault.Transfer[] memory t = _one(address(0), alice, 0.9 ether);
        bytes32 next = Wots.pk(SEED, 1);
        bytes32[67] memory s = Wots.sign(SEED, 0, vault.digest(id, t, relayer, 0.01 ether, next));
        vm.prank(alice);
        vm.expectRevert(BunkerVault.NotRelayer.selector);
        vault.execute(id, t, relayer, 0.01 ether, next, s);
        vm.prank(relayer);
        vault.execute(id, t, relayer, 0.01 ether, next, s);
        assertEq(relayer.balance, 0.01 ether);
        assertEq(alice.balance, 0.9 ether);
        assertEq(vault.balanceOf(id, address(0)), 0.09 ether);
    }

    function test_open_relay_pays_submitter() public {
        vault.depositETH{value: 1 ether}(id);
        BunkerVault.Transfer[] memory t = _one(address(0), alice, 0.5 ether);
        bytes32 next = Wots.pk(SEED, 1);
        bytes32[67] memory s = Wots.sign(SEED, 0, vault.digest(id, t, address(0), 0.001 ether, next));
        address anyone = makeAddr("anyone");
        vm.prank(anyone);
        vault.execute(id, t, address(0), 0.001 ether, next, s);
        assertEq(anyone.balance, 0.001 ether);
    }

    function test_failing_recipients_are_credited_not_reverted() public {
        Rejecter rej = new Rejecter();
        FeeToken ft = new FeeToken();
        ft.mint(address(this), 1000);
        ft.approve(address(vault), 1000);
        vault.deposit(id, address(ft), 1000); // 900 credited
        vault.depositETH{value: 1 ether}(id);
        ft.block_(address(rej), true);

        BunkerVault.Transfer[] memory t = new BunkerVault.Transfer[](2);
        t[0] = BunkerVault.Transfer(address(0), address(rej), 1 ether);
        t[1] = BunkerVault.Transfer(address(ft), address(rej), 900);
        _exec(t, address(0), 0);
        assertEq(vault.claimable(address(rej), address(0)), 1 ether);
        assertEq(vault.claimable(address(rej), address(ft)), 900);
        (bytes32 key,) = vault.accounts(id);
        assertEq(key, Wots.pk(SEED, 1)); // rotated anyway

        ft.block_(address(rej), false);
        vm.prank(alice); // anyone can push a claim to its recipient
        vault.claim(address(rej), address(ft));
        assertEq(ft.balanceOf(address(rej)), 810);
        assertEq(ft.balanceOf(alice), 0);
        vm.expectRevert(BunkerVault.ClaimFailed.selector);
        vault.claim(address(rej), address(0)); // still rejects ETH; the credit stays
        assertEq(vault.claimable(address(rej), address(0)), 1 ether);
        vm.expectRevert(BunkerVault.NothingReceived.selector);
        vault.claim(alice, address(0));
    }

    function test_gas_burning_recipient_is_credited() public {
        GasBurner burner = new GasBurner();
        vault.depositETH{value: 1 ether}(id);
        _exec(_one(address(0), address(burner), 1 ether), address(0), 0);
        assertEq(vault.claimable(address(burner), address(0)), 1 ether);
        (, uint64 nonce) = vault.accounts(id);
        assertEq(nonce, 1);
    }

    /// A front-runner who copies a pending withdrawal and resubmits it with too little gas can not push the sends
    /// into `claimable` (which would force a fresh recipient to sign). The call reverts; the real one still works.
    function test_low_gas_front_run_reverts_instead_of_crediting() public {
        Picky picky = new Picky(); // a recipient that needs ~30k gas to accept ETH
        vault.depositETH{value: 1 ether}(id);
        BunkerVault.Transfer[] memory t = _one(address(0), address(picky), 1 ether);
        bytes32 next = Wots.pk(SEED, 1);
        bytes32[67] memory s = Wots.sign(SEED, 0, vault.digest(id, t, address(0), 0, next));
        for (uint256 g = 150_000; g <= 260_000; g += 10_000) {
            try vault.execute{gas: g}(id, t, address(0), 0, next, s) {
                // if it went through with this much gas, the send must have succeeded, never been credited
                assertEq(vault.claimable(address(picky), address(0)), 0, "starved send was credited");
                assertEq(address(picky).balance, 1 ether);
                return;
            } catch {}
        }
        vault.execute(id, t, address(0), 0, next, s);
        assertEq(address(picky).balance, 1 ether);
        assertEq(vault.claimable(address(picky), address(0)), 0);
    }

    function test_reentrancy_blocked() public {
        Reenterer re = new Reenterer(vault);
        vault.depositETH{value: 1 ether}(id);
        _exec(_one(address(0), address(re), 1 ether), address(0), 0);
        // the reentrant deposit inside receive() hit the lock, so the send failed and was credited
        assertEq(vault.claimable(address(re), address(0)), 1 ether);
        assertEq(address(re).balance, 0);
    }

    // ------------------------------------------------------------------ WOTS properties

    /// One signature never lets anyone sign a different message: for any two digests some digit (message or
    /// checksum) of the new one is LOWER than the signed one, which would need a keccak preimage.
    function testFuzz_checksum_blocks_forgery(bytes32 a, bytes32 b) public pure {
        vm.assume(a != b);
        uint256[67] memory da = Wots.digits(a);
        uint256[67] memory db = Wots.digits(b);
        bool lower;
        for (uint256 i; i < 67; ++i) {
            if (db[i] < da[i]) lower = true;
        }
        assertTrue(lower);
    }

    function testFuzz_sign_verify_roundtrip(uint256 seed, uint64 k, bytes32 d) public view {
        assertEq(vault.wotsPublicKey(d, Wots.sign(seed, k, d)), Wots.pk(seed, k));
    }

    function test_extreme_digests() public view {
        bytes32[2] memory ds = [bytes32(0), bytes32(type(uint256).max)];
        for (uint256 i; i < 2; ++i) {
            assertEq(vault.wotsPublicKey(ds[i], Wots.sign(SEED, 3, ds[i])), Wots.pk(SEED, 3));
        }
    }
}
