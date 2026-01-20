// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { TimeLockedVault } from '../src/TimeLockedVault.sol';

interface Vm {
    function warp(uint256) external;
    function expectRevert(bytes calldata) external;
}

contract TimeLockedVaultTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256('hevm cheat code')))));

    TimeLockedVault private vault;

    receive() external payable {}

    function setUp() public {
        vault = new TimeLockedVault();
    }

    function testDepositSetsUnlock() public {
        uint256 start = block.timestamp;
        vault.deposit{ value: 1 ether }(3600);

        require(vault.balanceOf(address(this)) == 1 ether, 'balance mismatch');
        require(vault.unlockTimeOf(address(this)) == uint64(start + 3600), 'unlock mismatch');
    }

    function testWithdrawBeforeUnlockReverts() public {
        vault.deposit{ value: 1 ether }(3600);
        uint64 unlockTime = vault.unlockTimeOf(address(this));

        vm.expectRevert(abi.encodeWithSelector(TimeLockedVault.LockActive.selector, unlockTime));
        vault.withdraw(1 ether);
    }

    function testExtendLock() public {
        vault.deposit{ value: 1 ether }(3600);
        uint64 initial = vault.unlockTimeOf(address(this));
        uint64 extended = initial + 3600;

        vault.extendLock(extended);
        require(vault.unlockTimeOf(address(this)) == extended, 'extend failed');
    }

    function testWithdrawAfterUnlock() public {
        vault.deposit{ value: 1 ether }(3600);
        vm.warp(block.timestamp + 3600);

        vault.withdraw(1 ether);
        require(vault.balanceOf(address(this)) == 0, 'withdraw failed');
    }

    function testWithdrawAllAfterUnlock() public {
        vault.deposit{ value: 2 ether }(3600);
        vm.warp(block.timestamp + 3600);

        vault.withdrawAll();
        require(vault.balanceOf(address(this)) == 0, 'withdraw all failed');
    }
}
