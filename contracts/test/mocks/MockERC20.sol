// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Plain mintable ERC-20 for tests (stands in for any token a user parks in the vault).
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
        totalSupply += v;
        emit Transfer(address(0), to, v);
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        emit Approval(msg.sender, s, v);
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        return _t(msg.sender, to, v);
    }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= v;
        return _t(f, to, v);
    }

    function _t(address f, address to, uint256 v) internal returns (bool) {
        balanceOf[f] -= v;
        balanceOf[to] += v;
        emit Transfer(f, to, v);
        return true;
    }
}
