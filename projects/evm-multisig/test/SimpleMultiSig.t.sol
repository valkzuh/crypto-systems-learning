// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { SimpleMultiSig } from '../src/SimpleMultiSig.sol';

interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function deal(address who, uint256 newBalance) external;
    function expectRevert(bytes calldata) external;
}

contract SimpleMultiSigTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256('hevm cheat code')))));

    SimpleMultiSig private multisig;
    address private ownerA = address(0xA11);
    address private ownerB = address(0xB11);
    address private ownerC = address(0xC11);
    address private recipient = address(0xD11);

    function setUp() public {
        address[] memory owners = new address[](3);
        owners[0] = ownerA;
        owners[1] = ownerB;
        owners[2] = ownerC;

        multisig = new SimpleMultiSig(owners, 2);
    }

    function testSubmitApproveExecute() public {
        vm.deal(address(multisig), 2 ether);

        vm.prank(ownerA);
        multisig.submit(recipient, 1 ether, '');

        vm.prank(ownerA);
        multisig.approve(0);

        vm.prank(ownerB);
        multisig.approve(0);

        uint256 beforeBalance = recipient.balance;

        vm.prank(ownerA);
        multisig.execute(0);

        require(recipient.balance == beforeBalance + 1 ether, 'recipient not paid');
    }

    function testRevokeApproval() public {
        vm.prank(ownerA);
        multisig.submit(recipient, 0, '');

        vm.prank(ownerA);
        multisig.approve(0);

        vm.prank(ownerA);
        multisig.revoke(0);

        (, , , , uint256 approvals) = multisig.getTransaction(0);
        require(approvals == 0, 'approval not revoked');
    }

    function testExecuteWithoutThresholdReverts() public {
        vm.deal(address(multisig), 1 ether);

        vm.prank(ownerA);
        multisig.submit(recipient, 1 ether, '');

        vm.prank(ownerA);
        multisig.approve(0);

        vm.expectRevert(
            abi.encodeWithSelector(
                SimpleMultiSig.InsufficientApprovals.selector,
                0,
                1,
                2
            )
        );
        vm.prank(ownerA);
        multisig.execute(0);
    }

    function testNonOwnerCannotApprove() public {
        vm.prank(address(0xEE));
        vm.expectRevert(abi.encodeWithSelector(SimpleMultiSig.NotOwner.selector));
        multisig.approve(0);
    }
}
