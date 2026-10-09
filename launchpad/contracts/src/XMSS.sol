// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title XMSS
/// @notice Verifies a hash-based many-time signature: a Merkle tree of height 10 (1,024 leaves) over Winternitz
///         one-time keys (WOTS, w = 16, 67 chains). Every hash is keccak256, tweaked with the identity's public
///         `seed` and the exact position it is computed at, so work spent attacking one chain, leaf or identity
///         says nothing about any other. No elliptic curve is involved anywhere: a quantum computer that breaks
///         ECDSA gets nothing here.
///
///         chain step  F(x, leaf, i, j)  = keccak256(seed ‖ x ‖ uint32 leaf ‖ uint8 i ‖ uint8 j)        70 bytes
///         leaf        L(leaf, ends)     = keccak256(seed ‖ uint32 leaf ‖ end_0 ‖ … ‖ end_66)         2,180 bytes
///         node        N(h, j, l, r)     = keccak256(seed ‖ uint8 h ‖ uint32 j ‖ l ‖ r)               101 bytes
///
///         digits: the 64 nibbles of the 32-byte digest (most significant first), then the 3 nibbles of the
///         checksum sum(15 - digit) (most significant first). Chain i's signature element sits at step digit_i;
///         its public end is step 15. N(h, j, ·) is node j on level h (leaves are level 0, the root is N(10, 0)).
///
///         Each leaf may sign ONE message. Enforcing that is the caller's job (see BunkerLaunchpad's leaf bitmap).
library XMSS {
    uint256 internal constant HEIGHT = 10;
    uint256 internal constant LEAVES = 1 << HEIGHT;

    /// @notice The Merkle root that `wots` (a WOTS signature of `digest` by `leaf`) and `auth` (the leaf's sibling
    ///         path, leaf level first) lead to. The signature is valid iff this equals the identity's root.
    function rootOf(
        bytes32 seed,
        uint256 leaf,
        bytes32 digest,
        bytes32[67] calldata wots,
        bytes32[10] calldata auth
    ) internal pure returns (bytes32 node) {
        require(leaf < LEAVES, "leaf");
        assembly ("memory-safe") {
            let cb := mload(0x40) // chain buffer: seed | x | leaf(4) i(1) j(1)           (70 bytes, 96 reserved)
            let lb := add(cb, 0x60) // leaf/node buffer: seed | leaf(4) | ends(67 x 32)   (2,180 bytes)
            mstore(cb, seed)
            mstore(lb, seed)
            mstore(add(lb, 0x20), shl(224, leaf))
            let csum := 0
            for { let i := 0 } lt(i, 67) { i := add(i, 1) } {
                let digit
                switch lt(i, 64)
                case 1 {
                    digit := and(shr(sub(252, shl(2, i)), digest), 0xf)
                    csum := add(csum, sub(15, digit))
                }
                default { digit := and(shr(shl(2, sub(66, i)), csum), 0xf) }
                let x := calldataload(add(wots, shl(5, i)))
                // leaf(4) | i(1) | j(1) live at bytes 64..69; j is rewritten each step
                mstore(add(cb, 0x40), or(shl(224, leaf), shl(216, i)))
                for { let j := digit } lt(j, 15) { j := add(j, 1) } {
                    mstore(add(cb, 0x20), x)
                    mstore8(add(cb, 69), j)
                    x := keccak256(cb, 70)
                }
                mstore(add(lb, add(36, shl(5, i))), x)
            }
            node := keccak256(lb, 2180)

            // climb: N(h, j, l, r) = keccak256(seed | h(1) | j(4) | l | r), reusing lb (seed already at lb)
            let idx := leaf
            for { let h := 0 } lt(h, 10) { h := add(h, 1) } {
                let sib := calldataload(add(auth, shl(5, h)))
                let parent := shr(1, idx)
                mstore(add(lb, 0x20), or(shl(248, add(h, 1)), shl(216, parent)))
                switch and(idx, 1)
                case 0 {
                    mstore(add(lb, 37), node)
                    mstore(add(lb, 69), sib)
                }
                default {
                    mstore(add(lb, 37), sib)
                    mstore(add(lb, 69), node)
                }
                node := keccak256(lb, 101)
                idx := parent
            }
        }
    }
}
