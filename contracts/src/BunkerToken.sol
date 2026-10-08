// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

interface IPositionManager {
    function initializePool(PoolKey calldata key, uint160 sqrtPriceX96) external payable returns (int24);
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function nextTokenId() external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @title Bunker Mode ($BUNKER)
/// @notice Fixed-supply ERC-20 that launches its own Uniswap v4 pool and keeps the liquidity locked inside itself.
///
///         - The whole 1,000,000,000 supply is minted to this contract. `launch()` (deployer, once) creates the ETH pool
///           and puts ALL of it in as one single-sided position owned by this contract. There is no function that
///           removes liquidity or moves the position: the LP is locked forever. `collectFees()` (anyone) only claims
///           the position's trading fees and sends them to `feeRecipient`.
///         - 2% max wallet while `limitsInEffect`: no wallet may end a transfer holding more than 20,000,000 BUNKER.
///           Only the pool (Uniswap's PoolManager), this contract and the burn address are exempt; the deployer is not.
///           `removeLimits()` (deployer) switches it off for good; it can never be switched back on.
///         - No mint, no tax, no blacklist, no pause. No EIP-2612 permit(): an off-chain signature reveals the signer's
///           public key, which is exactly what bunker mode avoids.
contract BunkerToken {
    string public constant name = "Bunker Mode";
    string public constant symbol = "BUNKER";
    uint8 public constant decimals = 18;
    uint256 public constant totalSupply = 1_000_000_000e18;
    uint256 public constant MAX_WALLET = totalSupply / 50; // 2%

    // Uniswap v4 on Ethereum mainnet
    address public constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    IPositionManager public constant POSITION_MANAGER = IPositionManager(0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e);
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice Can call `launch()` once and `removeLimits()` once. Nothing else. `renounceOwnership()` clears it.
    address public owner;
    /// @notice Receives the locked position's trading fees. Only the current recipient can hand the role over.
    address public feeRecipient;
    bool public limitsInEffect = true;
    /// @notice The Uniswap v4 position this contract holds forever (0 until launch).
    uint256 public lpTokenId;
    PoolKey public poolKey;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Launched(uint256 indexed lpTokenId, uint24 fee, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity);
    event LimitsRemoved();
    event OwnershipRenounced();
    event FeeRecipientChanged(address indexed to);
    event FeesCollected(address indexed to, uint256 eth, uint256 bunker);

    error NotOwner();
    error AlreadyLaunched();
    error NotLaunched();
    error MaxWallet();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address feeRecipient_) {
        require(feeRecipient_ != address(0), "recipient=0");
        owner = msg.sender;
        feeRecipient = feeRecipient_;
        balanceOf[address(this)] = totalSupply;
        emit Transfer(address(0), address(this), totalSupply);
    }

    // ------------------------------------------------------------------ ERC-20

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
            balanceOf[to] += value; // cannot overflow: the sum of all balances is totalSupply
        }
        if (limitsInEffect && balanceOf[to] > MAX_WALLET && to != POOL_MANAGER && to != address(this) && to != DEAD) {
            revert MaxWallet();
        }
        emit Transfer(from, to, value);
    }

    // ------------------------------------------------------------------ launch + locked liquidity

    /// @notice Creates the ETH/BUNKER Uniswap v4 pool at `sqrtPriceX96` and adds the whole supply as one single-sided
    ///         position over [tickLower, tickUpper] (the start price is the top of the range, so no ETH is needed).
    ///         The position is owned by this contract forever. Rounding dust that does not fit is burned.
    ///         `fee`/`tickSpacing` are chosen at launch time, so nobody can pre-create the pool to block it.
    function launch(uint24 fee, int24 tickSpacing, uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper, uint128 liquidity)
        external
        onlyOwner
    {
        if (lpTokenId != 0) revert AlreadyLaunched();
        PoolKey memory key = PoolKey(address(0), address(this), fee, tickSpacing, address(0));
        poolKey = key;
        POSITION_MANAGER.initializePool(key, sqrtPriceX96); // no-op if it already exists; the mint below then
        // reverts unless the price is at or above our range (amount0Max = 0: this contract never pays ETH)

        allowance[address(this)][PERMIT2] = type(uint256).max;
        IPermit2(PERMIT2).approve(address(this), address(POSITION_MANAGER), uint160(totalSupply), uint48(block.timestamp));

        uint256 id = POSITION_MANAGER.nextTokenId();
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(key, tickLower, tickUpper, uint256(liquidity), uint128(0), uint128(totalSupply), address(this), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);
        POSITION_MANAGER.modifyLiquidities(abi.encode(abi.encodePacked(uint8(0x02), uint8(0x0d)), params), block.timestamp); // MINT_POSITION, SETTLE_PAIR
        require(POSITION_MANAGER.ownerOf(id) == address(this), "lp not held");
        lpTokenId = id;

        allowance[address(this)][PERMIT2] = 0;
        uint256 dust = balanceOf[address(this)];
        if (dust != 0) _move(address(this), DEAD, dust);
        emit Launched(id, fee, tickSpacing, tickLower, tickUpper, liquidity);
    }

    /// @notice Claims the locked position's trading fees (ETH + BUNKER) to `feeRecipient`. Anyone may call it.
    ///         Liquidity is never touched: the position is decreased by exactly 0.
    function collectFees() external returns (uint256 ethOut, uint256 bunkerOut) {
        uint256 id = lpTokenId;
        if (id == 0) revert NotLaunched();
        address to = feeRecipient;
        uint256 e0 = to.balance;
        uint256 b0 = balanceOf[to];
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(id, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(poolKey.currency0, poolKey.currency1, to);
        POSITION_MANAGER.modifyLiquidities(abi.encode(abi.encodePacked(uint8(0x01), uint8(0x11)), params), block.timestamp); // DECREASE_LIQUIDITY 0, TAKE_PAIR
        ethOut = to.balance - e0;
        bunkerOut = balanceOf[to] - b0;
        emit FeesCollected(to, ethOut, bunkerOut);
    }

    /// @notice Liquidity still sitting in the locked position (never goes down).
    function lockedLiquidity() external view returns (uint128) {
        return lpTokenId == 0 ? 0 : POSITION_MANAGER.getPositionLiquidity(lpTokenId);
    }

    // ------------------------------------------------------------------ admin (one-way switches only)

    /// @notice Switches the 2% max wallet off for good.
    function removeLimits() external onlyOwner {
        limitsInEffect = false;
        emit LimitsRemoved();
    }

    function renounceOwnership() external onlyOwner {
        owner = address(0);
        emit OwnershipRenounced();
    }

    function setFeeRecipient(address to) external {
        require(msg.sender == feeRecipient, "not recipient");
        require(to != address(0), "recipient=0");
        feeRecipient = to;
        emit FeeRecipientChanged(to);
    }

    /// @dev The position manager mints with _mint (no callback) today; accepting safe transfers too is harmless.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
