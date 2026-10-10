// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IBunkerVault {
    struct Transfer {
        address token; // address(0) = ETH
        address to;
        uint256 amount;
    }

    function execute(
        bytes32 id,
        Transfer[] calldata transfers,
        address relayer,
        uint256 fee,
        bytes32 nextKey,
        bytes32[67] calldata sig
    ) external;
    function depositETH(bytes32 id) external payable;
    function deposit(bytes32 id, address token, uint256 amount) external;
    function claim(address to, address token) external;
    function claimable(address to, address token) external view returns (uint256);
    function balanceOf(bytes32 id, address token) external view returns (uint256);
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @dev ERC-20 calls that accept tokens returning nothing (USDT) and never copy return data.
library Tokens {
    error TokenCallFailed();

    function balanceOf(address token, address who) internal view returns (uint256 b) {
        bool ok;
        assembly ("memory-safe") {
            mstore(0, 0x70a0823100000000000000000000000000000000000000000000000000000000)
            mstore(4, who)
            ok := and(gt(returndatasize(), 31), staticcall(gas(), token, 0, 36, 0, 32))
            b := mload(0)
        }
        if (!ok) revert TokenCallFailed();
    }

    function transfer(address token, address to, uint256 amount) internal {
        _call(token, 0xa9059cbb00000000000000000000000000000000000000000000000000000000, to, amount);
    }

    function approve(address token, address spender, uint256 amount) internal {
        _call(token, 0x095ea7b300000000000000000000000000000000000000000000000000000000, spender, amount);
    }

    /// @dev success = call ok AND (no return data OR returned true) AND token has code.
    function _call(address token, bytes32 selector, address a, uint256 v) private {
        bool ok;
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, selector)
            mstore(add(p, 4), a)
            mstore(add(p, 36), v)
            mstore(0, 0)
            ok := call(gas(), token, 0, p, 68, 0, 32)
            if ok {
                switch returndatasize()
                case 0 { ok := gt(extcodesize(token), 0) }
                default { ok := eq(mload(0), 1) }
            }
        }
        if (!ok) revert TokenCallFailed();
    }
}

/// @title BunkerBox
/// @notice Every swap order has one box: a tiny proxy at an address that is a hash of the order. The vault pays the
///         order's funds to that address, and only BunkerSwap can move them on, under the rules of that order.
contract BunkerBox {
    address internal immutable SWAP = msg.sender;

    error NotSwap();
    error SweepFailed();

    receive() external payable {}

    /// @notice Sends this box's whole balance of `token` (address(0) = ETH) to BunkerSwap.
    function sweep(address token) external returns (uint256 amount) {
        if (msg.sender != SWAP) revert NotSwap();
        if (token == address(0)) {
            amount = address(this).balance;
            if (amount != 0) {
                bool ok;
                address to = SWAP;
                assembly ("memory-safe") {
                    ok := call(gas(), to, amount, 0, 0, 0, 0)
                }
                if (!ok) revert SweepFailed();
            }
        } else {
            amount = Tokens.balanceOf(token, address(this));
            if (amount != 0) Tokens.transfer(token, SWAP, amount);
        }
    }
}

/// @title BunkerSwap
/// @notice Swaps for BunkerVault accounts. Funds go vault -> Uniswap -> the same vault account in one transaction, so
///         they never sit in a wallet that an ECDSA key controls.
///
///         The vault only signs "send this amount to that address". The swap terms are tied to that signature through
///         the address: an order's funds are sent to its box, and the box address is a hash of the whole order
///         (account, tokens, minimum out, deadline, the exact Uniswap route). Change any term and the address changes,
///         so the hash signature no longer matches.
///
///         Before the deadline `run` either does the swap in full or reverts and changes nothing. After the deadline
///         the same signature only hands the funds back to the bunker, so a signed order can always be executed and
///         the owner never has to sign a second message with the same one-time key. An order is only swappable in
///         the last `MAX_LIFE` before its deadline, so no order can freeze a bunker for longer than that.
///
///         The submitter (a wallet, a relayer, a bot) only pays gas and gets the order's `tip`; the output always
///         goes to the bunker that signed. An order may name the one address allowed to swap it; handing an expired
///         order back is open to anyone, so nobody depends on that address.
///
///         One side of every swap is ETH. The fee is `FEE_BPS` of the ETH side, fixed at deploy. No owner, no
///         upgrade, no pause: `platform` can only change where the fee is paid.
contract BunkerSwap {
    struct Order {
        bytes32 id; // the bunker that pays and receives
        uint64 nonce; // a salt that makes every box address unique; the site uses the bunker's key index
        address tokenIn; // address(0) = ETH
        address tokenOut; // address(0) = ETH; exactly one side is ETH
        uint256 amountIn; // what the vault sends to the box
        uint256 minOut; // least the vault must credit the bunker, after the fee and the tip
        uint256 tip; // ETH for whoever submits (0 when the owner submits it themselves)
        address submitter; // if set, the only address that may swap it (anyone may hand it back once expired)
        uint64 deadline; // swap until this time; after it the order only hands the funds back
        bytes32 route; // keccak256(abi.encode(commands, inputs)) of the Universal Router call
    }

    bytes32 public constant TAG = keccak256("BunkerSwap.order.v1");
    uint256 public constant MAX_FEE_BPS = 100;
    /// @notice An order whose deadline is further away than this is not swappable yet, only returnable.
    uint256 public constant MAX_LIFE = 1 hours;
    /// @dev Gas given to "hand the funds back" after the deadline. `run` reverts if the submitter did not supply
    ///      enough to give it this budget, so a low gas limit can not push funds into the stranded path.
    uint256 internal constant RETURN_GAS = 500_000;
    uint256 internal constant PUSH_GAS = 30_000;

    IBunkerVault public immutable VAULT;
    IUniversalRouter public immutable ROUTER;
    uint256 public immutable FEE_BPS;
    /// @notice The code every order box points at.
    address public immutable BOX;
    bytes32 internal immutable BOX_INIT_HASH;

    /// @notice Receives the swap fee.
    address public platform;
    /// @notice Fees that could not be pushed to `platform` at swap time; `collect()` sends them.
    uint256 public owed;

    uint256 private _lock = 1;

    event Swapped(
        bytes32 indexed id,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee,
        uint256 tip,
        address submitter
    );
    event Returned(bytes32 indexed id, address indexed token, uint256 amount, address submitter);
    event Stranded(bytes32 indexed id, address indexed token, address box);
    event PlatformSet(address platform);

    error BadOrder();
    error BadRoute();
    error BadConfig();
    error NothingThere();
    error TooLittle(uint256 out);
    error BoxFailed();
    error PayFailed();
    error NotPlatform();
    error NotSelf();
    error NotSubmitter();
    error OutOfGas();
    error Locked();

    modifier locked() {
        if (_lock != 1) revert Locked();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(IBunkerVault vault, IUniversalRouter router, address platform_, uint256 feeBps) {
        if (address(vault).code.length == 0 || address(router).code.length == 0) revert BadConfig();
        if (platform_ == address(0) || feeBps > MAX_FEE_BPS) revert BadConfig();
        VAULT = vault;
        ROUTER = router;
        FEE_BPS = feeBps;
        platform = platform_;
        address box = address(new BunkerBox());
        BOX = box;
        BOX_INIT_HASH = keccak256(_boxInitCode(box));
        emit PlatformSet(platform_);
    }

    /// @dev ETH out of a sell (from the router or the v4 pool manager), unspent ETH and box sweeps all arrive here.
    receive() external payable {}

    // ------------------------------------------------------------------ orders

    function orderHash(Order calldata o) public pure returns (bytes32) {
        return keccak256(abi.encode(TAG, o));
    }

    /// @notice The address the vault must pay for this order. This is what ties the order to the hash signature.
    function boxOf(Order calldata o) public view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), orderHash(o), BOX_INIT_HASH))))
        );
    }

    /// @notice Executes a signed order. The owner signs BunkerVault's digest for
    ///         `transfers = [(o.tokenIn, boxOf(o), o.amountIn)]`, `relayer = this contract`, `fee = 0`.
    /// @param commands Universal Router commands; with `inputs` they must hash to `o.route`
    function run(
        Order calldata o,
        bytes32 nextKey,
        bytes32[67] calldata sig,
        bytes calldata commands,
        bytes[] calldata inputs
    ) external locked {
        bool live = block.timestamp <= o.deadline && o.deadline - block.timestamp <= MAX_LIFE;
        if (live) {
            if ((o.tokenIn == address(0)) == (o.tokenOut == address(0))) revert BadOrder();
            if (o.submitter != address(0) && o.submitter != msg.sender) revert NotSubmitter();
            if (keccak256(abi.encode(commands, inputs)) != o.route) revert BadRoute();
        }

        address box = boxOf(o);
        uint256 undelivered = live ? VAULT.claimable(box, o.tokenIn) : 0;
        _pull(o, box, nextKey, sig);

        if (!live) {
            // The key is rotated. Handing the funds back must not be able to undo that, so a token that can not be
            // moved right now leaves them in the box for `rescue`.
            if (gasleft() < (RETURN_GAS * 64) / 63 + 20_000) revert OutOfGas();
            try this.handBack{gas: RETURN_GAS}(o, msg.sender) returns (uint256 amount) {
                emit Returned(o.id, o.tokenIn, amount, msg.sender);
            } catch {
                emit Stranded(o.id, o.tokenIn, box);
            }
            return;
        }

        // If the vault could not deliver (it books a failed send as claimable), nothing of this order is swapped.
        if (VAULT.claimable(box, o.tokenIn) != undelivered) revert NothingThere();
        uint256 got = _sweep(_box(o), o.tokenIn);
        if (got == 0) revert NothingThere();
        if (o.tokenIn == address(0)) _buy(o, got, commands, inputs);
        else _sell(o, got, commands, inputs);
    }

    /// @dev Vault -> box, authorised by the hash signature.
    function _pull(Order calldata o, address box, bytes32 nextKey, bytes32[67] calldata sig) private {
        IBunkerVault.Transfer[] memory t = new IBunkerVault.Transfer[](1);
        t[0] = IBunkerVault.Transfer(o.tokenIn, box, o.amountIn);
        VAULT.execute(o.id, t, address(this), 0, nextKey, sig);
    }

    /// @notice Returns whatever sits in an order's box (or is owed to it by the vault) to the order's bunker. Anyone
    ///         may call it: the funds can only go to that bunker.
    function rescue(Order calldata o, address token) external locked returns (uint256 amount) {
        address box = _box(o);
        if (VAULT.claimable(box, token) != 0) VAULT.claim(box, token);
        amount = _giveBack(o.id, box, token, 0, address(0));
        emit Returned(o.id, token, amount, msg.sender);
    }

    /// @dev The post-deadline leg of `run`, as a call of its own so `run` can survive its failure.
    function handBack(Order calldata o, address submitter) external returns (uint256) {
        if (msg.sender != address(this)) revert NotSelf();
        return _giveBack(o.id, _box(o), o.tokenIn, o.tip, submitter);
    }

    // ------------------------------------------------------------------ fee

    function collect() external locked {
        uint256 amount = owed;
        if (amount == 0) revert NothingThere();
        owed = 0;
        if (!_sendETH(platform, amount, gasleft())) revert PayFailed();
    }

    function setPlatform(address next) external {
        if (msg.sender != platform) revert NotPlatform();
        if (next == address(0)) revert BadConfig();
        platform = next;
        emit PlatformSet(next);
    }

    // ------------------------------------------------------------------ internals

    function _buy(Order calldata o, uint256 got, bytes calldata commands, bytes[] calldata inputs) private {
        uint256 fee = (got * FEE_BPS) / 10_000;
        if (got <= fee + o.tip) revert BadOrder();
        // the router is sent got - fee - tip; `kept` is what stays here if it uses all of that
        uint256 kept = address(this).balance - (got - fee - o.tip);
        uint256 held = Tokens.balanceOf(o.tokenOut, address(this)); // strays are not this order's
        ROUTER.execute{value: got - fee - o.tip}(commands, inputs, o.deadline);
        _settleBuy(o, got, fee, kept, held);
    }

    function _settleBuy(Order calldata o, uint256 got, uint256 fee, uint256 kept, uint256 held) private {
        uint256 out = Tokens.balanceOf(o.tokenOut, address(this)) - held;
        if (out == 0) revert TooLittle(0);
        out = _depositToken(o.id, o.tokenOut, out);
        if (out < o.minOut) revert TooLittle(out);
        uint256 unspent = address(this).balance - kept;
        if (unspent != 0) VAULT.depositETH{value: unspent}(o.id);
        _pay(fee, o.tip);
        emit Swapped(o.id, address(0), o.tokenOut, got, out, fee, o.tip, msg.sender);
    }

    function _sell(Order calldata o, uint256 got, bytes calldata commands, bytes[] calldata inputs) private {
        uint256 before = address(this).balance;
        uint256 held = Tokens.balanceOf(o.tokenIn, address(this)) - got; // strays are not this order's
        Tokens.transfer(o.tokenIn, address(ROUTER), got);
        ROUTER.execute(commands, inputs, o.deadline);
        _settleSell(o, got, address(this).balance - before, held);
    }

    function _settleSell(Order calldata o, uint256 got, uint256 out, uint256 held) private {
        uint256 fee = (out * FEE_BPS) / 10_000;
        if (out < fee + o.tip + o.minOut || out == fee + o.tip) revert TooLittle(out);
        uint256 net = out - fee - o.tip;
        VAULT.depositETH{value: net}(o.id);
        uint256 unspent = Tokens.balanceOf(o.tokenIn, address(this)) - held;
        if (unspent != 0) _depositToken(o.id, o.tokenIn, unspent);
        _pay(fee, o.tip);
        emit Swapped(o.id, o.tokenIn, address(0), got, net, fee, o.tip, msg.sender);
    }

    function _pay(uint256 fee, uint256 tip) private {
        if (fee != 0 && !_sendETH(platform, fee, PUSH_GAS)) owed += fee;
        if (tip != 0 && !_sendETH(msg.sender, tip, gasleft())) revert PayFailed();
    }

    /// @dev Box -> bunker `id`. `tip` is only ever paid out of returned ETH, and never blocks the return.
    function _giveBack(bytes32 id, address box, address token, uint256 tip, address tipTo)
        private
        returns (uint256 amount)
    {
        amount = _sweep(box, token);
        if (amount == 0) revert NothingThere();
        if (token == address(0)) {
            if (tip == 0 || tip >= amount || !_sendETH(tipTo, tip, PUSH_GAS)) tip = 0;
            VAULT.depositETH{value: amount - tip}(id);
        } else {
            _depositToken(id, token, amount);
        }
    }

    /// @dev Empties the box into this contract. For a token the result is what arrived here, not what the box sent
    ///      (a token that takes a cut on transfer delivers less), and never includes tokens that were already here.
    function _sweep(address box, address token) private returns (uint256 got) {
        if (token == address(0)) return BunkerBox(payable(box)).sweep(token);
        uint256 held = Tokens.balanceOf(token, address(this));
        BunkerBox(payable(box)).sweep(token);
        got = Tokens.balanceOf(token, address(this)) - held;
    }

    /// @return credited what the vault booked to the bunker (less than `amount` for a token with a transfer cut)
    function _depositToken(bytes32 id, address token, uint256 amount) private returns (uint256 credited) {
        credited = VAULT.balanceOf(id, token);
        Tokens.approve(token, address(VAULT), amount);
        VAULT.deposit(id, token, amount);
        credited = VAULT.balanceOf(id, token) - credited;
    }

    /// @dev The order's box, deployed on first use.
    function _box(Order calldata o) private returns (address box) {
        box = boxOf(o);
        if (box.code.length != 0) return box;
        bytes32 salt = orderHash(o);
        bytes memory init = _boxInitCode(BOX);
        address made;
        assembly ("memory-safe") {
            made := create2(0, add(init, 0x20), mload(init), salt)
        }
        if (made != box) revert BoxFailed();
    }

    /// @dev EIP-1167 minimal proxy to `impl`.
    function _boxInitCode(address impl) private pure returns (bytes memory) {
        return abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", impl, hex"5af43d82803e903d91602b57fd5bf3"
        );
    }

    function _sendETH(address to, uint256 amount, uint256 g) private returns (bool ok) {
        assembly ("memory-safe") {
            ok := call(g, to, amount, 0, 0, 0, 0) // no returndata copy (return-bomb safe)
        }
    }
}
