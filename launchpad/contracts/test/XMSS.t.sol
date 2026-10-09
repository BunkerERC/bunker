// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {XMSS} from "../src/XMSS.sol";

contract XMSSHarness {
    function rootOf(bytes32 seed, uint256 leaf, bytes32 digest, bytes32[67] calldata wots, bytes32[10] calldata auth)
        external
        pure
        returns (bytes32)
    {
        return XMSS.rootOf(seed, leaf, digest, wots, auth);
    }
}

/// @dev Vectors come from the browser signer (site/src/lib/pq/xmss.js) via `node scripts/pq-cli.mjs vectors`.
contract XMSSTest is Test {
    XMSSHarness h;
    string json;
    bytes32 seed;
    bytes32 root;

    struct Case {
        bytes32 digest;
        uint256 leaf;
        bytes32[67] wots;
        bytes32[10] auth;
    }

    function setUp() public {
        h = new XMSSHarness();
        json = vm.readFile("test/vectors/xmss.json");
        seed = vm.parseJsonBytes32(json, ".seed");
        root = vm.parseJsonBytes32(json, ".root");
    }

    function _case(uint256 i) internal view returns (Case memory c) {
        string memory p = string.concat(".cases[", vm.toString(i), "]");
        c.digest = vm.parseJsonBytes32(json, string.concat(p, ".digest"));
        c.leaf = vm.parseJsonUint(json, string.concat(p, ".leaf"));
        bytes32[] memory w = vm.parseJsonBytes32Array(json, string.concat(p, ".wots"));
        bytes32[] memory a = vm.parseJsonBytes32Array(json, string.concat(p, ".auth"));
        assertEq(w.length, 67);
        assertEq(a.length, 10);
        for (uint256 k; k < 67; ++k) c.wots[k] = w[k];
        for (uint256 k; k < 10; ++k) c.auth[k] = a[k];
    }

    function test_allVectorsVerify() public view {
        for (uint256 i; i < 12; ++i) {
            Case memory c = _case(i);
            assertEq(h.rootOf(seed, c.leaf, c.digest, c.wots, c.auth), root, string.concat("case ", vm.toString(i)));
        }
    }

    function test_gasWorstAndBestCase() public {
        Case memory worst = _case(0); // digest 0x00..: 990 chain steps
        Case memory best = _case(1); // digest 0xff..: 45 chain steps
        uint256 g = gasleft();
        h.rootOf(seed, worst.leaf, worst.digest, worst.wots, worst.auth);
        uint256 gWorst = g - gasleft();
        g = gasleft();
        h.rootOf(seed, best.leaf, best.digest, best.wots, best.auth);
        uint256 gBest = g - gasleft();
        emit log_named_uint("verify gas, worst case", gWorst);
        emit log_named_uint("verify gas, best case", gBest);
        assertLt(gWorst, 170_000);
    }

    function test_anyTamperingChangesTheRoot() public view {
        Case memory c = _case(2);
        bytes32 r = h.rootOf(seed, c.leaf, c.digest, c.wots, c.auth);
        assertEq(r, root);
        assertTrue(h.rootOf(seed, c.leaf, c.digest ^ bytes32(uint256(1)), c.wots, c.auth) != root, "digest bit");
        assertTrue(h.rootOf(seed, c.leaf ^ 1, c.digest, c.wots, c.auth) != root, "leaf index");
        assertTrue(h.rootOf(seed ^ bytes32(uint256(1)), c.leaf, c.digest, c.wots, c.auth) != root, "seed");
        c.wots[40] = c.wots[40] ^ bytes32(uint256(1));
        assertTrue(h.rootOf(seed, c.leaf, c.digest, c.wots, c.auth) != root, "wots element");
        c.wots[40] = c.wots[40] ^ bytes32(uint256(1));
        c.auth[9] = c.auth[9] ^ bytes32(uint256(1));
        assertTrue(h.rootOf(seed, c.leaf, c.digest, c.wots, c.auth) != root, "auth node");
    }

    /// Advancing a signature element one step forges a digit upward, but the checksum then needs a step BACK.
    function test_cannotForgeByAdvancingAChain() public view {
        Case memory c = _case(2);
        // chain 0 sits at the digest's top nibble; bump that nibble by one and advance σ_0 by one step
        bytes32 d2 = bytes32(uint256(c.digest) + (uint256(1) << 252));
        bytes memory buf = abi.encodePacked(seed, c.wots[0], uint32(c.leaf), uint8(0), uint8(uint256(c.digest) >> 252));
        c.wots[0] = keccak256(buf);
        assertTrue(h.rootOf(seed, c.leaf, d2, c.wots, c.auth) != root);
    }

    function test_leafOutOfRangeReverts() public {
        Case memory c = _case(0);
        vm.expectRevert(bytes("leaf"));
        h.rootOf(seed, 1024, c.digest, c.wots, c.auth);
    }
}
