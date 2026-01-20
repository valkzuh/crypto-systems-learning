// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title TimeLockedVault
/// @notice Simple per-user time-locked ETH vault.
contract TimeLockedVault {
    struct Lock {
        uint256 balance;
        uint64 unlockTime;
    }

    mapping(address => Lock) private locks;

    error ZeroDeposit();
    error ZeroAmount();
    error LockDurationZero();
    error LockActive(uint64 unlockTime);
    error InsufficientBalance(uint256 available, uint256 required);
    error UnlockTimeNotInFuture(uint64 currentUnlock, uint64 newUnlock);
    error NoBalance();

    event Deposited(address indexed user, uint256 amount, uint64 unlockTime);
    event LockExtended(address indexed user, uint64 newUnlockTime);
    event Withdrawn(address indexed user, uint256 amount);

    /// @notice Deposit ETH and set a lock duration from now.
    function deposit(uint64 lockDurationSeconds) external payable {
        if (msg.value == 0) revert ZeroDeposit();
        if (lockDurationSeconds == 0) revert LockDurationZero();

        Lock storage userLock = locks[msg.sender];
        uint64 newUnlock = uint64(block.timestamp) + lockDurationSeconds;
        if (newUnlock > userLock.unlockTime) {
            userLock.unlockTime = newUnlock;
        }
        userLock.balance += msg.value;

        emit Deposited(msg.sender, msg.value, userLock.unlockTime);
    }

    /// @notice Extend the lock to a new unlock timestamp in the future.
    function extendLock(uint64 newUnlockTime) external {
        Lock storage userLock = locks[msg.sender];
        if (userLock.balance == 0) revert NoBalance();
        if (newUnlockTime <= userLock.unlockTime || newUnlockTime <= block.timestamp) {
            revert UnlockTimeNotInFuture(userLock.unlockTime, newUnlockTime);
        }

        userLock.unlockTime = newUnlockTime;
        emit LockExtended(msg.sender, newUnlockTime);
    }

    /// @notice Withdraw a specific amount after the lock expires.
    function withdraw(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();

        Lock storage userLock = locks[msg.sender];
        if (block.timestamp < userLock.unlockTime) revert LockActive(userLock.unlockTime);
        if (userLock.balance < amount) {
            revert InsufficientBalance(userLock.balance, amount);
        }

        userLock.balance -= amount;

        (bool ok, ) = msg.sender.call{ value: amount }('');
        require(ok, 'Transfer failed');

        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Withdraw the full balance after the lock expires.
    function withdrawAll() external {
        Lock storage userLock = locks[msg.sender];
        uint256 amount = userLock.balance;
        if (amount == 0) revert NoBalance();
        if (block.timestamp < userLock.unlockTime) revert LockActive(userLock.unlockTime);

        userLock.balance = 0;

        (bool ok, ) = msg.sender.call{ value: amount }('');
        require(ok, 'Transfer failed');

        emit Withdrawn(msg.sender, amount);
    }

    function balanceOf(address user) external view returns (uint256) {
        return locks[user].balance;
    }

    function unlockTimeOf(address user) external view returns (uint64) {
        return locks[user].unlockTime;
    }

    function timeLeft(address user) external view returns (uint64) {
        uint64 unlockTime = locks[user].unlockTime;
        if (block.timestamp >= unlockTime) {
            return 0;
        }
        return unlockTime - uint64(block.timestamp);
    }
}
