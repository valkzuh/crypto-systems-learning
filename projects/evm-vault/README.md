# EVM Vault

Time-locked ETH vault in Solidity with per-user locks, a minimal API, and Foundry tests.

## Features
- Per-user deposits with lock duration
- Extendable unlock time
- Partial or full withdrawals after unlock
- Events and custom errors for clarity

## Stack
Solidity 0.8.20, Foundry

## Project Layout
- `src/TimeLockedVault.sol` Contract implementation
- `test/TimeLockedVault.t.sol` Foundry tests
- `foundry.toml` Foundry configuration

## Quick Start
```bash
cd projects/evm-vault
forge test
```

## Contract Interface
- `deposit(uint64 lockDurationSeconds)` Deposit ETH and set lock duration.
- `extendLock(uint64 newUnlockTime)` Extend the unlock time to a future timestamp.
- `withdraw(uint256 amount)` Withdraw a specific amount after unlock.
- `withdrawAll()` Withdraw the full balance after unlock.
- `balanceOf(address user)` View current balance.
- `unlockTimeOf(address user)` View unlock timestamp.
- `timeLeft(address user)` View seconds remaining until unlock.

## Notes
- This vault holds ETH only.
- Locks are enforced per user.
- Unlock times can only move forward.
