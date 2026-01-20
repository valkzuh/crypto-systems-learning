# EVM Multisig

Minimal N-of-M multisig wallet in Solidity with Foundry tests. Useful for admin control of protocol settings, upgrades, and emergency actions.

## Features
- Multiple owners with a configurable approval threshold
- Submit, approve, revoke, and execute transactions
- ETH receive support
- Events and custom errors for clear state transitions

## Stack
Solidity 0.8.20, Foundry

## Project Layout
- `src/SimpleMultiSig.sol` Contract implementation
- `test/SimpleMultiSig.t.sol` Foundry tests
- `foundry.toml` Foundry configuration

## Quick Start
```bash
cd projects/evm-multisig
forge test
```

## Contract Interface
- `submit(address to, uint256 value, bytes data)` Propose a transaction
- `approve(uint256 txId)` Approve a transaction
- `revoke(uint256 txId)` Revoke a prior approval
- `execute(uint256 txId)` Execute once approvals meet the threshold
- `getOwners()` Returns owners list
- `getTransaction(uint256 txId)` Returns transaction details

## Notes
- Any owner can execute after threshold approvals.
- Approvals are tracked per transaction per owner.
- ETH transfers use low-level call and will revert on failure.
