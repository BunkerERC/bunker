// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IBunkerVault {
    function accounts(bytes32 id) external view returns (bytes32 key, uint64 nonce);
    function deposit(bytes32 id, address token, uint256 amount) external;
}

/// @title BunkerTripwire
/// @notice An on-chain ECDSA canary wired to an escape hatch into BunkerVault.
///
///         CANARY. `canary` is an Ethereum address whose secp256k1 public key comes from a hash, nothing up the
///         sleeve: x = keccak256(CANARY_SEED ‖ uint256 counter) for the first counter that lands on the curve, with
///         the even y. Nobody knows its private key, so a signature from it means secp256k1 ECDSA has been broken.
///         The ETH in this contract is a bounty for exactly that: `claim` pays all of it to whoever presents one.
///
///         TRIP. The wire trips, once and forever, the first time the canary signs: a valid `claim`, or code at the
///         canary address (an EIP-7702 delegation, which needs a canary signature too; `trip()` records it).
///
///         ESCAPE. A wallet opts in by naming its bunker (a BunkerVault account id) and approving tokens to this
///         contract. While the wire is armed nothing can move. Once it trips, anyone may call `escape` and each
///         approved token balance goes straight into the owner's bunker, where only the owner's hash-based key can
///         reach it. Tokens never go anywhere else.
///
///         No owner, no admin, no upgrade, no fee. Bounty ETH can only leave through `claim`.
contract BunkerTripwire {
    string public constant CANARY_SEED = "BUNKER/TRIPWIRE/CANARY/v1";
    /// @dev Domain tag of the message the canary must sign to claim the bounty.
    bytes32 public constant CLAIM_TAG = keccak256("BunkerTripwire.claim.v1");
    uint256 public constant MAX_TOKENS = 32;
    /// @dev Gas given to each token move during an escape, so one bad token can not eat a whole batch.
    uint256 public constant MOVE_GAS = 600_000;

    uint256 internal constant P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;

    IBunkerVault public immutable vault;
    uint256 public immutable canaryX;
    uint256 public immutable canaryY;
    uint256 public immutable canaryCounter;
    address public immutable canary;

    /// @notice Timestamp of the trip, 0 while armed.
    uint256 public trippedAt;
    /// @notice First address paid by `claim`.
    address public claimedBy;

    /// @notice BunkerVault account id each member's tokens escape into (0 = not a member).
    mapping(address owner => bytes32) public bunkerOf;
    mapping(address owner => address[]) internal _tokens;
    mapping(address owner => bool) internal _listed;
    address[] internal _list;

    uint256 private _lock = 1;

    event Funded(address indexed from, uint256 amount);
    event Claimed(address indexed to, uint256 amount);
    event Tripped(address indexed by, uint256 timestamp);
    event Registered(address indexed owner, bytes32 indexed bunker, address[] tokens);
    event Left(address indexed owner);
    event Escaped(address indexed owner, address indexed token, bytes32 indexed bunker, uint256 amount);
    event EscapeFailed(address indexed owner, address indexed token);

    error Armed();
    error AlreadyTripped();
    error BadSignature();
    error PayoutFailed();
    error BunkerNotOpen();
    error TooManyTokens();
    error BadToken();
    error OnlySelf();
    error OutOfGas();
    error Locked();

    modifier locked() {
        if (_lock != 1) revert Locked();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(IBunkerVault vault_) payable {
        vault = vault_;
        (uint256 x, uint256 y, uint256 counter) = _canaryKey();
        canaryX = x;
        canaryY = y;
        canaryCounter = counter;
        address c = address(uint160(uint256(keccak256(abi.encodePacked(x, y)))));
        canary = c;
        if (msg.value != 0) emit Funded(msg.sender, msg.value);
    }

    // ------------------------------------------------------------------ bounty

    receive() external payable {
        _fund();
    }

    function fund() external payable {
        _fund();
    }

    function _fund() private {
        if (trippedAt != 0) revert AlreadyTripped();
        emit Funded(msg.sender, msg.value);
    }

    /// @notice The message the canary key must sign to pay the bounty to `to`. It is hashed here, never taken as a
    ///         parameter: with a free choice of hash, a signature for any public key can be made without its key.
    function claimDigest(address to) public view returns (bytes32) {
        return keccak256(abi.encode(CLAIM_TAG, block.chainid, address(this), to));
    }

    /// @notice Pays the whole bounty to `to` against a canary signature of `claimDigest(to)` and trips the wire.
    ///         The signature names `to`, so copying it from the mempool only pays the same `to`.
    function claim(address to, uint8 v, bytes32 r, bytes32 s) external locked {
        if (ecrecover(claimDigest(to), v, r, s) != canary) revert BadSignature();
        if (claimedBy == address(0)) claimedBy = to;
        _trip(to);
        uint256 amount = address(this).balance;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert PayoutFailed();
        emit Claimed(to, amount);
    }

    /// @notice Records a trip caused by code at the canary address.
    function trip() external {
        if (trippedAt != 0) revert AlreadyTripped();
        if (canary.code.length == 0) revert Armed();
        _trip(msg.sender);
    }

    function _trip(address by) private {
        if (trippedAt != 0) return;
        trippedAt = block.timestamp;
        emit Tripped(by, block.timestamp);
    }

    /// @notice True once the canary has signed anything this contract can see.
    function isTripped() public view returns (bool) {
        return trippedAt != 0 || canary.code.length != 0;
    }

    // ------------------------------------------------------------------ membership

    /// @notice Names the bunker your tokens escape into and the tokens to move (approve each one to this contract).
    ///         The bunker must already exist in the vault. Call it again to change either; the latest call wins.
    function register(bytes32 bunker, address[] calldata tokens) external locked {
        (bytes32 key,) = vault.accounts(bunker);
        if (bunker == 0 || key == 0) revert BunkerNotOpen();
        if (tokens.length > MAX_TOKENS) revert TooManyTokens();
        for (uint256 i; i < tokens.length; ++i) {
            address t = tokens[i];
            if (t == address(0) || t.code.length == 0 || t == address(vault) || t == address(this)) revert BadToken();
        }
        bunkerOf[msg.sender] = bunker;
        _tokens[msg.sender] = tokens;
        if (!_listed[msg.sender]) {
            _listed[msg.sender] = true;
            _list.push(msg.sender);
        }
        emit Registered(msg.sender, bunker, tokens);
    }

    /// @notice Opts out: nothing of yours will move. Revoke your approvals too.
    function leave() external locked {
        delete bunkerOf[msg.sender];
        delete _tokens[msg.sender];
        emit Left(msg.sender);
    }

    function tokensOf(address owner) external view returns (address[] memory) {
        return _tokens[owner];
    }

    function memberCount() external view returns (uint256) {
        return _list.length;
    }

    function members(uint256 start, uint256 count) external view returns (address[] memory out) {
        uint256 n = _list.length;
        if (start >= n) return out;
        if (count > n - start) count = n - start;
        out = new address[](count);
        for (uint256 i; i < count; ++i) {
            out[i] = _list[start + i];
        }
    }

    // ------------------------------------------------------------------ escape

    /// @notice After the trip, moves `owner`'s approved tokens into their bunker. Anyone may call it, any number of
    ///         times; each call moves what is there now. A token that fails is skipped and reported.
    function escape(address owner) external locked {
        _armedCheck();
        _escape(owner);
    }

    function escapeMany(address[] calldata owners) external locked {
        _armedCheck();
        for (uint256 i; i < owners.length; ++i) {
            _escape(owners[i]);
        }
    }

    function _armedCheck() private {
        if (trippedAt != 0) return;
        if (canary.code.length == 0) revert Armed();
        _trip(msg.sender);
    }

    function _escape(address owner) private {
        bytes32 id = bunkerOf[owner];
        if (id == 0) return;
        address[] storage list = _tokens[owner];
        uint256 n = list.length;
        for (uint256 i; i < n; ++i) {
            address token = list[i];
            if (gasleft() < (MOVE_GAS * 64) / 63 + 40_000) revert OutOfGas();
            try this.moveOne{gas: MOVE_GAS}(owner, token, id) returns (uint256 got) {
                if (got != 0) emit Escaped(owner, token, id, got);
            } catch {
                emit EscapeFailed(owner, token);
            }
        }
    }

    /// @dev One token, all or nothing. Only callable by this contract (from `escape`).
    function moveOne(address owner, address token, bytes32 id) external returns (uint256 got) {
        if (msg.sender != address(this)) revert OnlySelf();
        uint256 amount = _read(token, abi.encodeWithSelector(0x70a08231, owner)); // balanceOf(owner)
        uint256 allowed = _read(token, abi.encodeWithSelector(0xdd62ed3e, owner, address(this))); // allowance
        if (allowed < amount) amount = allowed;
        if (amount == 0) return 0;

        uint256 before = _read(token, abi.encodeWithSelector(0x70a08231, address(this)));
        _call(token, abi.encodeWithSelector(0x23b872dd, owner, address(this), amount)); // transferFrom
        got = _read(token, abi.encodeWithSelector(0x70a08231, address(this))) - before;
        if (got == 0) return 0;

        if (!_try(token, abi.encodeWithSelector(0x095ea7b3, address(vault), got))) {
            _call(token, abi.encodeWithSelector(0x095ea7b3, address(vault), 0)); // tokens that need a reset first
            _call(token, abi.encodeWithSelector(0x095ea7b3, address(vault), got));
        }
        vault.deposit(id, token, got);
    }

    // ------------------------------------------------------------------ canary key

    /// @dev Hash-to-curve by try-and-increment. Virtual only so tests can stand in a key they hold.
    function _canaryKey() internal view virtual returns (uint256 x, uint256 y, uint256 counter) {
        for (counter = 0;; ++counter) {
            x = uint256(keccak256(abi.encodePacked(CANARY_SEED, counter)));
            if (x >= P) continue;
            uint256 rhs = addmod(mulmod(mulmod(x, x, P), x, P), 7, P);
            y = _modexp(rhs, (P + 1) / 4, P); // P ≡ 3 (mod 4)
            if (mulmod(y, y, P) != rhs) continue;
            if (y & 1 == 1) y = P - y;
            return (x, y, counter);
        }
    }

    /// @notice Uncompressed public key of the canary (0x04 ‖ x ‖ y).
    function canaryPublicKey() external view returns (bytes memory) {
        return abi.encodePacked(uint8(4), canaryX, canaryY);
    }

    function _modexp(uint256 b, uint256 e, uint256 m) private view returns (uint256 r) {
        (bool ok, bytes memory out) = address(5).staticcall(abi.encode(32, 32, 32, b, e, m));
        require(ok && out.length == 32);
        r = abi.decode(out, (uint256));
    }

    // ------------------------------------------------------------------ token calls

    function _read(address token, bytes memory data) private view returns (uint256 v) {
        (bool ok, bytes memory ret) = token.staticcall(data);
        if (!ok || ret.length < 32) revert BadToken();
        v = abi.decode(ret, (uint256));
    }

    /// @dev Success = call ok AND (no return data OR returned true) AND the token has code.
    function _try(address token, bytes memory data) private returns (bool) {
        if (token.code.length == 0) return false;
        (bool ok, bytes memory ret) = token.call(data);
        return ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))));
    }

    function _call(address token, bytes memory data) private {
        if (!_try(token, data)) revert BadToken();
    }
}
