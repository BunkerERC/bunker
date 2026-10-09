// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title BunkerLaunchToken
/// @notice The ERC-20 every launch creates. Fixed supply of 1,000,000,000 (18 decimals), all minted once to the
///         launchpad, which puts it into the coin's Uniswap v4 pool in the same transaction.
///
///         No owner, no mint, no tax, no blacklist, no pause, no max wallet. No EIP-2612 permit(): an off-chain
///         ECDSA signature exposes the signer's public key, which is exactly what post-quantum hygiene avoids.
contract BunkerLaunchToken {
    uint8 public constant decimals = 18;
    uint256 public constant totalSupply = 1_000_000_000e18;

    string public name;
    string public symbol;
    /// @notice The launchpad that created this token and verified its post-quantum attestation.
    address public immutable launchpad;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
        launchpad = msg.sender;
        balanceOf[msg.sender] = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "allowance");
            unchecked {
                allowance[from][msg.sender] = allowed - value;
            }
        }
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) private {
        uint256 bal = balanceOf[from];
        require(bal >= value, "balance");
        unchecked {
            balanceOf[from] = bal - value;
            balanceOf[to] += value; // cannot overflow: all balances sum to totalSupply
        }
        emit Transfer(from, to, value);
    }
}
