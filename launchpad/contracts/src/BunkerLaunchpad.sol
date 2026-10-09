// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {XMSS} from "./XMSS.sol";
import {BunkerLaunchToken} from "./BunkerLaunchToken.sol";

// ---------------------------------------------------------------- Uniswap v4 (only what we call)

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 callerDelta, int256 feesAccrued);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 swapDelta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

interface IBunkerVault {
    function depositETH(bytes32 id) external payable;
    function deposit(bytes32 id, address token, uint256 amount) external;
}

/// @title BunkerLaunchpad
/// @notice Launches ERC-20s whose provenance is a hash-based (post-quantum) signature, verified on-chain.
///
///         A creator's identity is a Merkle root over 1,024 Winternitz one-time keys (see XMSS.sol), generated in the
///         browser from the creator's 24-word bunker phrase (the same phrase that opens their BunkerVault account,
///         domain-separated), which never touches an elliptic curve. `launch` checks the creator's XMSS
///         signature over every field of the coin (name, ticker, metadata, image, dev buy, where the dev bag and the
///         creator fees go, and the launching wallet) BEFORE anything is created, then burns that one-time key in an
///         on-chain bitmap. Nothing about a coin's provenance depends on a server or a database: the check happened
///         in the launch transaction, and the signature is in its logs for anyone to re-verify with keccak256 alone.
///
///         Every coin gets the same Uniswap v4 pool: native ETH / token, 1% fee, the whole supply as one single-sided
///         position from the start price upward. This contract is the pool's hook (beforeInitialize only) so nobody
///         can create a coin's pool ahead of it, and it owns the position with no function that removes it: the
///         liquidity is locked forever. The dev buy happens in the same transaction, before anyone else can trade.
///
///         Trading fees: anyone can `collect`; half goes to the creator (a wallet or a BunkerVault account), half to
///         the platform. Only the creator's post-quantum key can redirect the creator half (`setFeeTo`).
///
///         No owner, no admin, no upgrade, no pause. `platform` can only change where the platform half goes.
contract BunkerLaunchpad {
    // ---------------------------------------------------------------- pool shape (identical for every coin)

    uint24 public constant FEE = 10_000; // 1%
    int24 public constant TICK_SPACING = 200;
    int24 public constant TICK_LOWER = -887_200; // lowest usable tick: the range runs to (practically) infinite price
    uint160 internal constant MIN_PRICE_LIMIT = 4_295_128_740; // TickMath.MIN_SQRT_PRICE + 1
    uint160 internal constant MAX_PRICE_LIMIT = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341; // MAX - 1
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint256 public constant CREATOR_SHARE_BPS = 5_000; // 50% of trading fees to the creator, 50% to the platform

    bytes32 public constant LAUNCH_TAG = keccak256("BunkerLaunchpad.launch.v1");
    bytes32 public constant FEE_TAG = keccak256("BunkerLaunchpad.setFeeTo.v1");

    uint256 public constant MAX_NAME = 32;
    uint256 public constant MAX_SYMBOL = 12;
    uint256 public constant MAX_META = 1_024;
    uint256 public constant MAX_IMAGE = 24_576;

    uint8 private constant ACT_LAUNCH = 1;
    uint8 private constant ACT_BUY = 2;
    uint8 private constant ACT_SELL = 3;
    uint8 private constant ACT_COLLECT = 4;

    IPoolManager public immutable poolManager;
    IBunkerVault public immutable vault;
    /// @notice Start price of every pool (= the top of the position's range, so the position is 100% token).
    uint160 public immutable startSqrtPriceX96;
    int24 public immutable tickUpper;
    /// @notice Liquidity of each coin's locked position (sized so the whole supply fits; the rounding dust is burned).
    uint128 public immutable liquidity;

    /// @notice Receives the platform half of the trading fees. Only the current platform address can change it.
    address public platform;

    struct LaunchParams {
        string name;
        string symbol;
        string meta; // JSON: description and links
        bytes image; // small image (webp/png/jpeg/gif), stored in the Image log
        address devTo; // receives the dev buy (unused when devVault is set)
        bytes32 devVault; // BunkerVault account that receives the dev buy instead
        address feeTo; // creator half of the trading fees (unused when feeVault is set)
        bytes32 feeVault; // BunkerVault account that receives the creator half instead
    }

    /// @notice An XMSS signature together with the identity it claims to come from.
    struct PQSig {
        bytes32 seed;
        bytes32 root;
        uint32 leaf;
        bytes32[67] wots;
        bytes32[10] auth;
    }

    struct Coin {
        bytes32 identity;
        address creator; // the wallet that sent the launch transaction
        uint32 leaf;
        uint64 launchedAt;
        address feeTo;
        uint64 launchBlock; // every log of the launch is in this block: one cheap eth_getLogs for the UI
        bytes32 feeVault;
    }

    struct Identity {
        uint64 firstSeen;
        uint32 launches;
    }

    mapping(address token => Coin) public coins;
    address[] public allCoins;
    mapping(bytes32 identity => Identity) public identities;
    /// @notice One-time keys an identity has used: bit (leaf % 256) of word (leaf / 256).
    mapping(bytes32 identity => mapping(uint256 word => uint256 bits)) public usedLeaves;
    /// @notice ETH that could not be pushed to a fee recipient (a contract that reverts or needs more gas).
    mapping(address to => uint256) public claimableETH;
    /// @notice Fees whose BunkerVault deposit failed; anyone can retry with `flushVault`.
    mapping(bytes32 vaultId => mapping(address currency => uint256)) public pendingVault;

    uint256 private _lock = 1;

    event Launched(
        address indexed token,
        bytes32 indexed identity,
        address indexed creator,
        uint32 leaf,
        string name,
        string symbol,
        string meta,
        uint256 devBuy,
        uint256 devTokens
    );
    event Payees(address indexed token, address devTo, bytes32 devVault, address feeTo, bytes32 feeVault);
    event Attested(
        address indexed token,
        bytes32 digest,
        bytes32 seed,
        bytes32 root,
        uint32 leaf,
        bytes32[67] wots,
        bytes32[10] auth
    );
    event Image(address indexed token, bytes image);
    event IdentitySeen(bytes32 indexed identity, bytes32 seed, bytes32 root);
    event FeeToChanged(address indexed token, address feeTo, bytes32 feeVault, uint32 leaf);
    event Collected(address indexed token, uint256 eth, uint256 tokens, uint256 creatorEth, uint256 creatorTokens);
    event Credited(address indexed to, uint256 amount);
    event Claimed(address indexed to, uint256 amount);
    event VaultPending(bytes32 indexed vaultId, address indexed currency, uint256 amount);
    event PlatformChanged(address platform);

    error Locked();

    modifier nonReentrant() {
        if (_lock != 1) revert Locked();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(
        IPoolManager poolManager_,
        IBunkerVault vault_,
        address platform_,
        uint160 startSqrtPriceX96_,
        int24 tickUpper_,
        uint128 liquidity_
    ) {
        require(platform_ != address(0), "platform");
        require(tickUpper_ > TICK_LOWER && tickUpper_ % TICK_SPACING == 0, "tick");
        poolManager = poolManager_;
        vault = vault_;
        platform = platform_;
        startSqrtPriceX96 = startSqrtPriceX96_;
        tickUpper = tickUpper_;
        liquidity = liquidity_;
    }

    // ---------------------------------------------------------------- launch

    /// @notice Creates the coin, its pool and its locked position, and executes the dev buy (msg.value), all in one
    ///         transaction, after verifying `s` over `launchDigest(...)`. `s.leaf` is burned for good.
    function launch(LaunchParams calldata p, PQSig calldata s) external payable nonReentrant returns (address token) {
        uint256 nl = bytes(p.name).length;
        uint256 sl = bytes(p.symbol).length;
        require(nl != 0 && nl <= MAX_NAME, "name");
        require(sl != 0 && sl <= MAX_SYMBOL, "symbol");
        require(bytes(p.meta).length <= MAX_META, "meta");
        require(p.image.length <= MAX_IMAGE, "image");
        require(p.feeTo != address(0) || p.feeVault != 0, "feeTo");
        require(msg.value == 0 || p.devTo != address(0) || p.devVault != 0, "devTo");

        bytes32 id = identityOf(s.seed, s.root);
        bytes32 d = launchDigest(id, s.leaf, msg.sender, msg.value, p);
        _verifyAndBurn(id, s, d);

        token = address(new BunkerLaunchToken{salt: keccak256(abi.encode(id, s.leaf))}(p.name, p.symbol));
        poolManager.initialize(poolKey(token), startSqrtPriceX96);

        address devReceiver = p.devVault != 0 ? address(this) : p.devTo;
        (uint256 devPaid, uint256 devTokens) = abi.decode(
            poolManager.unlock(abi.encode(ACT_LAUNCH, token, msg.value, uint256(0), address(this), devReceiver)),
            (uint256, uint256)
        );
        if (msg.value > devPaid) require(_sendETH(msg.sender, msg.value - devPaid, gasleft()), "refund");
        if (p.devVault != 0 && devTokens != 0) {
            BunkerLaunchToken(token).approve(address(vault), devTokens);
            vault.deposit(p.devVault, token, devTokens);
        }
        uint256 dust = BunkerLaunchToken(token).balanceOf(address(this));
        if (dust != 0) BunkerLaunchToken(token).transfer(DEAD, dust);

        coins[token] = Coin(id, msg.sender, s.leaf, uint64(block.timestamp), p.feeTo, uint64(block.number), p.feeVault);
        allCoins.push(token);
        Identity storage ident = identities[id];
        if (ident.firstSeen == 0) {
            ident.firstSeen = uint64(block.timestamp);
            emit IdentitySeen(id, s.seed, s.root);
        }
        ident.launches += 1;

        emit Launched(token, id, msg.sender, s.leaf, p.name, p.symbol, p.meta, msg.value, devTokens);
        emit Payees(token, p.devTo, p.devVault, p.feeTo, p.feeVault);
        emit Attested(token, d, s.seed, s.root, s.leaf, s.wots, s.auth);
        if (p.image.length != 0) emit Image(token, p.image);
    }

    /// @notice What the creator's one-time key signs to launch. Every field is hashed separately and ABI-encoded,
    ///         so no two different launches can share a digest.
    function launchDigest(bytes32 identity, uint32 leaf, address creator, uint256 devBuy, LaunchParams calldata p)
        public
        view
        returns (bytes32)
    {
        bytes32 content = keccak256(
            abi.encode(
                keccak256(bytes(p.name)), keccak256(bytes(p.symbol)), keccak256(bytes(p.meta)), keccak256(p.image)
            )
        );
        bytes32 payees = keccak256(abi.encode(p.devTo, p.devVault, p.feeTo, p.feeVault));
        return keccak256(
            abi.encode(LAUNCH_TAG, block.chainid, address(this), identity, leaf, creator, devBuy, content, payees)
        );
    }

    // ---------------------------------------------------------------- creator controls (post-quantum only)

    /// @notice Redirects the creator half of a coin's fees. Authorised ONLY by the creator's XMSS key (a fresh leaf);
    ///         whoever submits the transaction is irrelevant, so this keeps working after ECDSA breaks.
    function setFeeTo(address token, address feeTo, bytes32 feeVault, PQSig calldata s) external nonReentrant {
        Coin storage c = coins[token];
        require(c.launchedAt != 0, "coin");
        require(feeTo != address(0) || feeVault != 0, "feeTo");
        bytes32 id = identityOf(s.seed, s.root);
        require(id == c.identity, "identity");
        _verifyAndBurn(id, s, feeDigest(token, id, s.leaf, feeTo, feeVault));
        c.feeTo = feeTo;
        c.feeVault = feeVault;
        emit FeeToChanged(token, feeTo, feeVault, s.leaf);
    }

    function feeDigest(address token, bytes32 identity, uint32 leaf, address feeTo, bytes32 feeVault)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(FEE_TAG, block.chainid, address(this), token, identity, leaf, feeTo, feeVault));
    }

    function _verifyAndBurn(bytes32 id, PQSig calldata s, bytes32 d) private {
        require(XMSS.rootOf(s.seed, s.leaf, d, s.wots, s.auth) == s.root, "signature");
        uint256 word = s.leaf >> 8;
        uint256 bit = 1 << (s.leaf & 255);
        uint256 used = usedLeaves[id][word];
        require(used & bit == 0, "leaf used");
        usedLeaves[id][word] = used | bit;
    }

    // ---------------------------------------------------------------- trading (any v4 router works too)

    function buy(address token, uint256 minOut, address to, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 out)
    {
        require(block.timestamp <= deadline, "deadline");
        require(coins[token].launchedAt != 0, "coin");
        require(msg.value != 0, "amount");
        uint256 paid;
        (paid, out) = abi.decode(
            poolManager.unlock(abi.encode(ACT_BUY, token, msg.value, minOut, address(this), to)), (uint256, uint256)
        );
        if (msg.value > paid) require(_sendETH(msg.sender, msg.value - paid, gasleft()), "refund");
    }

    /// @notice Sells `amountIn` tokens (approve this contract first) for ETH sent to `to`.
    function sell(address token, uint256 amountIn, uint256 minOut, address to, uint256 deadline)
        external
        nonReentrant
        returns (uint256 out)
    {
        require(block.timestamp <= deadline, "deadline");
        require(coins[token].launchedAt != 0, "coin");
        require(amountIn != 0, "amount");
        (, out) = abi.decode(
            poolManager.unlock(abi.encode(ACT_SELL, token, amountIn, minOut, msg.sender, to)), (uint256, uint256)
        );
    }

    // ---------------------------------------------------------------- fees

    /// @notice Claims a coin's trading fees and splits them: half to the creator (wallet or BunkerVault account), half
    ///         to the platform. Anyone may call it. The locked liquidity itself is never touched.
    function collect(address token) external nonReentrant returns (uint256 eth, uint256 tokens) {
        Coin storage c = coins[token];
        require(c.launchedAt != 0, "coin");
        (eth, tokens) = abi.decode(
            poolManager.unlock(abi.encode(ACT_COLLECT, token, uint256(0), uint256(0), address(0), address(0))),
            (uint256, uint256)
        );
        uint256 creatorEth = (eth * CREATOR_SHARE_BPS) / 10_000;
        uint256 creatorTokens = (tokens * CREATOR_SHARE_BPS) / 10_000;
        _pay(c.feeTo, c.feeVault, address(0), creatorEth);
        _pay(c.feeTo, c.feeVault, token, creatorTokens);
        _pay(platform, 0, address(0), eth - creatorEth);
        _pay(platform, 0, token, tokens - creatorTokens);
        emit Collected(token, eth, tokens, creatorEth, creatorTokens);
    }

    /// @notice Pushes ETH credited to `to` (anyone may call it; the ETH can only go to `to`).
    function claim(address to) external nonReentrant {
        uint256 amount = claimableETH[to];
        require(amount != 0, "nothing");
        claimableETH[to] = 0;
        require(_sendETH(to, amount, gasleft()), "send");
        emit Claimed(to, amount);
    }

    /// @notice Retries a BunkerVault deposit that failed during `collect`.
    function flushVault(bytes32 vaultId, address currency) external nonReentrant {
        uint256 amount = pendingVault[vaultId][currency];
        require(amount != 0, "nothing");
        pendingVault[vaultId][currency] = 0;
        if (currency == address(0)) {
            vault.depositETH{value: amount}(vaultId);
        } else {
            BunkerLaunchToken(currency).approve(address(vault), amount);
            vault.deposit(vaultId, currency, amount);
        }
    }

    function setPlatform(address platform_) external {
        require(msg.sender == platform, "platform");
        require(platform_ != address(0), "zero");
        platform = platform_;
        emit PlatformChanged(platform_);
    }

    function _pay(address to, bytes32 vaultId, address currency, uint256 amount) private {
        if (amount == 0) return;
        if (vaultId != 0) {
            if (currency == address(0)) {
                try vault.depositETH{value: amount}(vaultId) {
                    return;
                } catch {}
            } else {
                BunkerLaunchToken(currency).approve(address(vault), amount);
                try vault.deposit(vaultId, currency, amount) {
                    return;
                } catch {
                    BunkerLaunchToken(currency).approve(address(vault), 0);
                }
            }
            pendingVault[vaultId][currency] += amount;
            emit VaultPending(vaultId, currency, amount);
            return;
        }
        if (currency != address(0)) {
            BunkerLaunchToken(currency).transfer(to, amount); // our own token: no hooks, cannot fail for a non-zero `to`
            return;
        }
        if (!_sendETH(to, amount, 100_000)) {
            claimableETH[to] += amount;
            emit Credited(to, amount);
        }
    }

    /// @dev No returndata copy (return-bomb safe).
    function _sendETH(address to, uint256 amount, uint256 g) private returns (bool ok) {
        assembly ("memory-safe") {
            ok := call(g, to, amount, 0, 0, 0, 0)
        }
    }

    // ---------------------------------------------------------------- Uniswap v4 plumbing

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "pm");
        (uint8 act, address token, uint256 amount, uint256 minOut, address payer, address to) =
            abi.decode(data, (uint8, address, uint256, uint256, address, address));
        PoolKey memory key = poolKey(token);

        if (act == ACT_LAUNCH) {
            (int256 delta,) = poolManager.modifyLiquidity(
                key, ModifyLiquidityParams(TICK_LOWER, tickUpper, int256(uint256(liquidity)), 0), ""
            );
            require(_amount0(delta) == 0, "eth in position");
            _payToken(token, address(this), uint256(-int256(_amount1(delta))));
            uint256 paid;
            uint256 out;
            if (amount != 0) (paid, out) = _buy(key, amount, to);
            return abi.encode(paid, out);
        }
        if (act == ACT_BUY) {
            (uint256 paid, uint256 out) = _buy(key, amount, to);
            require(out >= minOut, "slippage");
            return abi.encode(paid, out);
        }
        if (act == ACT_SELL) {
            int256 sd = poolManager.swap(key, SwapParams(false, -int256(amount), MAX_PRICE_LIMIT), "");
            uint256 owed = uint256(-int256(_amount1(sd)));
            uint256 out = uint256(int256(_amount0(sd)));
            require(out >= minOut, "slippage");
            _payToken(token, payer, owed);
            poolManager.take(address(0), to, out);
            return abi.encode(owed, out);
        }
        if (act == ACT_COLLECT) {
            (int256 delta,) =
                poolManager.modifyLiquidity(key, ModifyLiquidityParams(TICK_LOWER, tickUpper, 0, 0), "");
            uint256 eth = uint256(int256(_amount0(delta)));
            uint256 tokens = uint256(int256(_amount1(delta)));
            if (eth != 0) poolManager.take(address(0), address(this), eth);
            if (tokens != 0) poolManager.take(token, address(this), tokens);
            return abi.encode(eth, tokens);
        }
        revert("act");
    }

    /// @dev Exact-input ETH -> token swap; the ETH comes from this contract's balance (the caller's msg.value).
    function _buy(PoolKey memory key, uint256 amountIn, address to) private returns (uint256 paid, uint256 out) {
        int256 sd = poolManager.swap(key, SwapParams(true, -int256(amountIn), MIN_PRICE_LIMIT), "");
        paid = uint256(-int256(_amount0(sd)));
        out = uint256(int256(_amount1(sd)));
        poolManager.settle{value: paid}();
        poolManager.take(key.currency1, to, out);
    }

    function _payToken(address token, address from, uint256 amount) private {
        poolManager.sync(token);
        if (from == address(this)) BunkerLaunchToken(token).transfer(address(poolManager), amount);
        else BunkerLaunchToken(token).transferFrom(from, address(poolManager), amount);
        poolManager.settle();
    }

    // BalanceDelta packs amount0 in the high and amount1 in the low 128 bits; each half is an int128 by construction.
    function _amount0(int256 delta) private pure returns (int128) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return int128(delta >> 128);
    }

    function _amount1(int256 delta) private pure returns (int128) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return int128(delta);
    }

    /// @notice Uniswap v4 hook: only this contract may create pools that name it as their hook, so a coin's pool
    ///         can never exist (or be priced) before its launch transaction.
    function beforeInitialize(address sender, PoolKey calldata, uint160) external view returns (bytes4) {
        require(msg.sender == address(poolManager) && sender == address(this), "init");
        return this.beforeInitialize.selector;
    }

    receive() external payable {
        require(msg.sender == address(poolManager), "eth");
    }

    // ---------------------------------------------------------------- views

    function poolKey(address token) public view returns (PoolKey memory) {
        return PoolKey(address(0), token, FEE, TICK_SPACING, address(this));
    }

    function poolId(address token) external view returns (bytes32) {
        return keccak256(abi.encode(poolKey(token)));
    }

    function identityOf(bytes32 seed, bytes32 root) public pure returns (bytes32) {
        return keccak256(abi.encode(seed, root));
    }

    /// @notice Where `launch` will create the token for this identity, leaf, name and ticker.
    function tokenAddress(bytes32 identity, uint32 leaf, string calldata name, string calldata symbol)
        external
        view
        returns (address)
    {
        bytes32 initHash = keccak256(abi.encodePacked(type(BunkerLaunchToken).creationCode, abi.encode(name, symbol)));
        bytes32 salt = keccak256(abi.encode(identity, leaf));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash)))));
    }

    function coinsCount() external view returns (uint256) {
        return allCoins.length;
    }

    function coinsSlice(uint256 from, uint256 count) external view returns (address[] memory out) {
        uint256 n = allCoins.length;
        if (from >= n) return out;
        if (count > n - from) count = n - from;
        out = new address[](count);
        for (uint256 i; i < count; ++i) out[i] = allCoins[from + i];
    }

    function isLeafUsed(bytes32 identity, uint32 leaf) external view returns (bool) {
        return usedLeaves[identity][leaf >> 8] & (1 << (leaf & 255)) != 0;
    }

    /// @notice The identity's whole one-time-key bitmap (1,024 bits).
    function leafBitmap(bytes32 identity) external view returns (uint256[4] memory words) {
        for (uint256 i; i < 4; ++i) words[i] = usedLeaves[identity][i];
    }
}
