// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title BunkerVault
/// @notice Holds ETH and ERC-20s for accounts that are controlled by a hash-based one-time signature (Winternitz
///         WOTS, w = 16, keccak256) instead of an ECDSA key. Breaking secp256k1 does not let anyone move funds here:
///         a withdrawal needs keccak256 preimages that only the owner's secret seed can produce.
///
///         Every withdrawal is signed with the account's CURRENT one-time key and commits to the hash of the NEXT
///         key, so each key signs exactly one message and the account rotates on every move. Used keys are burned
///         forever (`spentKey`).
///
///         An account's id is the hash of its first public key. Anyone may deposit to an id; the first deposit opens
///         the account. Whoever submits the withdrawal transaction (any wallet, a relayer, a bot) only pays gas: the
///         signed message fixes every recipient and amount, so the submitter cannot change anything.
///
///         After a valid signature the call does not revert because of a recipient: an ETH or token send that fails
///         is credited to the recipient's `claimable` balance instead. So a signed message, once checked against the
///         account's balances, stays executable and the owner never has to sign a second message with the same key.
///
///         No owner, no admin, no upgrade, no fee.
contract BunkerVault {
    struct Account {
        bytes32 key; // hash of the current WOTS public key (0 = account does not exist)
        uint64 nonce; // number of executed withdrawals = index of the current key
    }

    struct Transfer {
        address token; // address(0) = ETH
        address to;
        uint256 amount;
    }

    /// @dev Domain tag of the signed message.
    bytes32 public constant TAG = keccak256("BunkerVault.execute.v1");
    /// @dev 64 base-16 digits of the digest + 3 base-16 checksum digits.
    uint256 public constant CHAINS = 67;

    mapping(bytes32 id => Account) public accounts;
    mapping(bytes32 id => mapping(address token => uint256)) public balanceOf;
    mapping(bytes32 key => bool) public spentKey;
    mapping(address to => mapping(address token => uint256)) public claimable;

    uint256 private _lock = 1;

    event Opened(bytes32 indexed id);
    event Deposited(bytes32 indexed id, address indexed token, address indexed from, uint256 amount);
    event Executed(bytes32 indexed id, uint64 nonce, bytes32 nextKey, address submitter, uint256 fee);
    event Sent(bytes32 indexed id, address indexed token, address indexed to, uint256 amount);
    event Credited(bytes32 indexed id, address indexed token, address indexed to, uint256 amount);
    event Claimed(address indexed to, address indexed token, uint256 amount);

    error UnknownAccount();
    error BadSignature();
    error BadNextKey();
    error NotRelayer();
    error Insufficient(address token);
    error BadTransfer();
    error NothingReceived();
    error Locked();
    error ClaimFailed();

    modifier locked() {
        if (_lock != 1) revert Locked();
        _lock = 2;
        _;
        _lock = 1;
    }

    receive() external payable {
        revert UnknownAccount(); // plain ETH has no account id; use depositETH(id)
    }

    // ------------------------------------------------------------------ deposits

    function depositETH(bytes32 id) external payable locked {
        if (msg.value == 0) revert NothingReceived();
        _open(id);
        balanceOf[id][address(0)] += msg.value;
        emit Deposited(id, address(0), msg.sender, msg.value);
    }

    /// @notice Pulls `amount` of `token` from the caller (approve first). Credits what actually arrived, so
    ///         fee-on-transfer tokens are accounted correctly. Rebasing tokens (e.g. stETH) are not supported: wrap
    ///         them first (wstETH).
    function deposit(bytes32 id, address token, uint256 amount) external locked {
        if (token == address(0) || token.code.length == 0) revert BadTransfer();
        _open(id);
        uint256 before = _balance(token);
        _pull(token, msg.sender, amount);
        uint256 received = _balance(token) - before;
        if (received == 0) revert NothingReceived();
        balanceOf[id][token] += received;
        emit Deposited(id, token, msg.sender, received);
    }

    function _open(bytes32 id) private {
        if (accounts[id].key != 0) return;
        if (id == 0 || spentKey[id]) revert BadNextKey();
        accounts[id].key = id;
        emit Opened(id);
    }

    // ------------------------------------------------------------------ withdrawals

    /// @notice Moves funds out of account `id`, authorised by a WOTS signature of `digest(...)` made with the
    ///         account's current key, and rotates the account to `nextKey`.
    /// @param relayer if non-zero, only this address may submit (stops anyone else front-running for the fee)
    /// @param fee ETH paid from the account to the submitter (0 when the owner submits it themselves)
    function execute(
        bytes32 id,
        Transfer[] calldata transfers,
        address relayer,
        uint256 fee,
        bytes32 nextKey,
        bytes32[67] calldata sig
    ) external locked {
        Account storage acct = accounts[id];
        bytes32 key = acct.key;
        if (key == 0) revert UnknownAccount();
        if (relayer != address(0) && msg.sender != relayer) revert NotRelayer();
        if (nextKey == 0 || nextKey == key || spentKey[nextKey]) revert BadNextKey();

        uint64 nonce = acct.nonce;
        bytes32 d = _digest(id, nonce, transfers, relayer, fee, nextKey);
        if (wotsPublicKey(d, sig) != key) revert BadSignature();

        // effects: burn the key, rotate, debit everything before any external call
        spentKey[key] = true;
        acct.key = nextKey;
        acct.nonce = nonce + 1;
        mapping(address => uint256) storage bal = balanceOf[id];
        if (fee != 0) {
            if (bal[address(0)] < fee) revert Insufficient(address(0));
            bal[address(0)] -= fee;
        }
        uint256 n = transfers.length;
        for (uint256 i; i < n; ++i) {
            Transfer calldata t = transfers[i];
            if (t.to == address(0) || t.to == address(this) || t.amount == 0) revert BadTransfer();
            if (bal[t.token] < t.amount) revert Insufficient(t.token);
            bal[t.token] -= t.amount;
        }
        emit Executed(id, nonce, nextKey, msg.sender, fee);

        // interactions: a failing recipient is credited, never reverts the withdrawal
        for (uint256 i; i < n; ++i) {
            Transfer calldata t = transfers[i];
            _send(id, t.token, t.to, t.amount);
        }
        if (fee != 0) _send(id, address(0), msg.sender, fee);
    }

    /// @notice Delivers a send that failed inside `execute` to its recipient `to`. Anyone may call it (the funds can
    ///         only go to `to`), so a recipient that is a fresh never-signed address does not have to sign to get paid.
    function claim(address to, address token) external locked {
        uint256 amount = claimable[to][token];
        if (amount == 0) revert NothingReceived();
        claimable[to][token] = 0;
        bool ok = token == address(0) ? _sendETH(to, amount, gasleft()) : _sendToken(token, to, amount, gasleft());
        if (!ok) revert ClaimFailed();
        emit Claimed(to, token, amount);
    }

    // ------------------------------------------------------------------ views

    /// @notice The message the owner must sign for the account's current key.
    function digest(bytes32 id, Transfer[] calldata transfers, address relayer, uint256 fee, bytes32 nextKey)
        external
        view
        returns (bytes32)
    {
        return _digest(id, accounts[id].nonce, transfers, relayer, fee, nextKey);
    }

    function _digest(
        bytes32 id,
        uint64 nonce,
        Transfer[] calldata transfers,
        address relayer,
        uint256 fee,
        bytes32 nextKey
    ) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                TAG, block.chainid, address(this), id, nonce, relayer, fee, nextKey, keccak256(abi.encode(transfers))
            )
        );
    }

    /// @notice Recomputes the WOTS public-key hash from a signature of `d`.
    ///         Digits: the 64 nibbles of `d` (most significant first), then the 3 nibbles of the checksum
    ///         sum(15 - digit) (most significant first). Chain step: x' = keccak256(x || uint8(chain) || uint8(step)).
    ///         Chain i's signature element sits at step digit_i; the public end is step 15. Public key hash =
    ///         keccak256(end_0 || ... || end_66).
    function wotsPublicKey(bytes32 d, bytes32[67] calldata sig) public pure returns (bytes32 pk) {
        assembly ("memory-safe") {
            let scratch := mload(0x40) // 34-byte hash input
            let ends := add(scratch, 0x40) // 67 x 32-byte chain ends
            let csum := 0
            for { let i := 0 } lt(i, 67) { i := add(i, 1) } {
                let digit
                switch lt(i, 64)
                case 1 {
                    digit := and(shr(sub(252, shl(2, i)), d), 0xf)
                    csum := add(csum, sub(15, digit))
                }
                default { digit := and(shr(shl(2, sub(66, i)), csum), 0xf) }
                let x := calldataload(add(sig, shl(5, i)))
                for { let j := digit } lt(j, 15) { j := add(j, 1) } {
                    mstore(scratch, x)
                    mstore8(add(scratch, 32), i)
                    mstore8(add(scratch, 33), j)
                    x := keccak256(scratch, 34)
                }
                mstore(add(ends, shl(5, i)), x)
            }
            pk := keccak256(ends, mul(67, 32))
        }
    }

    // ------------------------------------------------------------------ token plumbing

    /// @dev Each send inside `execute` gets a FIXED gas budget, and the call reverts if the submitter did not supply
    ///      enough gas to give it that budget. So whether a send succeeds never depends on the submitter's gas limit:
    ///      a front-runner can not starve a send into `claimable`; a recipient that burns its whole budget is credited.
    uint256 internal constant ETH_SEND_GAS = 100_000;
    uint256 internal constant TOKEN_SEND_GAS = 250_000;

    error OutOfGas();

    function _send(bytes32 id, address token, address to, uint256 amount) private {
        uint256 budget = token == address(0) ? ETH_SEND_GAS : TOKEN_SEND_GAS;
        if (gasleft() < (budget * 64) / 63 + 30_000) revert OutOfGas();
        bool ok = token == address(0) ? _sendETH(to, amount, budget) : _sendToken(token, to, amount, budget);
        if (ok) {
            emit Sent(id, token, to, amount);
        } else {
            claimable[to][token] += amount;
            emit Credited(id, token, to, amount);
        }
    }

    function _sendETH(address to, uint256 amount, uint256 g) private returns (bool ok) {
        assembly ("memory-safe") {
            ok := call(g, to, amount, 0, 0, 0, 0) // no returndata copy (return-bomb safe)
        }
    }

    /// @dev transfer(to, amount); success = call ok AND (no return data OR returned true) AND token has code.
    function _sendToken(address token, address to, uint256 amount, uint256 g) private returns (bool ok) {
        if (token.code.length == 0) return false;
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, 0xa9059cbb00000000000000000000000000000000000000000000000000000000)
            mstore(add(p, 4), to)
            mstore(add(p, 36), amount)
            mstore(0, 0)
            ok := call(g, token, 0, p, 68, 0, 32)
            if ok {
                if returndatasize() { ok := eq(mload(0), 1) }
            }
        }
    }

    function _pull(address token, address from, uint256 amount) private {
        bool ok;
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, 0x23b872dd00000000000000000000000000000000000000000000000000000000)
            mstore(add(p, 4), from)
            mstore(add(p, 36), address())
            mstore(add(p, 68), amount)
            mstore(0, 0)
            ok := call(gas(), token, 0, p, 100, 0, 32)
            if ok {
                if returndatasize() { ok := eq(mload(0), 1) }
            }
        }
        if (!ok) revert BadTransfer();
    }

    function _balance(address token) private view returns (uint256 b) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        if (!ok || ret.length < 32) revert BadTransfer();
        b = abi.decode(ret, (uint256));
    }
}
