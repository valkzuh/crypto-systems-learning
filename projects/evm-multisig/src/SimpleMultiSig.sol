// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title SimpleMultiSig
/// @notice Minimal N-of-M multisig wallet for ETH and arbitrary calls.
contract SimpleMultiSig {
    struct Transaction {
        address to;
        uint256 value;
        bytes data;
        bool executed;
        uint256 approvals;
    }

    address[] public owners;
    mapping(address => bool) public isOwner;
    uint256 public threshold;

    Transaction[] public transactions;
    mapping(uint256 => mapping(address => bool)) public approvedBy;

    error NotOwner();
    error InvalidOwners();
    error InvalidThreshold(uint256 threshold, uint256 ownersLength);
    error TxDoesNotExist(uint256 txId);
    error AlreadyExecuted(uint256 txId);
    error AlreadyApproved(uint256 txId);
    error NotApproved(uint256 txId);
    error InsufficientApprovals(uint256 txId, uint256 approvals, uint256 threshold);

    event Deposit(address indexed sender, uint256 amount, uint256 balance);
    event Submit(uint256 indexed txId, address indexed to, uint256 value, bytes data);
    event Approve(address indexed owner, uint256 indexed txId);
    event Revoke(address indexed owner, uint256 indexed txId);
    event Execute(uint256 indexed txId);

    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotOwner();
        _;
    }

    modifier txExists(uint256 txId) {
        if (txId >= transactions.length) revert TxDoesNotExist(txId);
        _;
    }

    modifier notExecuted(uint256 txId) {
        if (transactions[txId].executed) revert AlreadyExecuted(txId);
        _;
    }

    constructor(address[] memory owners_, uint256 threshold_) {
        if (owners_.length == 0) revert InvalidOwners();
        if (threshold_ == 0 || threshold_ > owners_.length) {
            revert InvalidThreshold(threshold_, owners_.length);
        }

        for (uint256 i = 0; i < owners_.length; i++) {
            address owner = owners_[i];
            if (owner == address(0) || isOwner[owner]) revert InvalidOwners();
            isOwner[owner] = true;
            owners.push(owner);
        }

        threshold = threshold_;
    }

    receive() external payable {
        emit Deposit(msg.sender, msg.value, address(this).balance);
    }

    /// @notice Create a new transaction proposal.
    function submit(address to, uint256 value, bytes calldata data) external onlyOwner {
        transactions.push(Transaction({
            to: to,
            value: value,
            data: data,
            executed: false,
            approvals: 0
        }));

        emit Submit(transactions.length - 1, to, value, data);
    }

    /// @notice Approve a transaction.
    function approve(uint256 txId) external onlyOwner txExists(txId) notExecuted(txId) {
        if (approvedBy[txId][msg.sender]) revert AlreadyApproved(txId);

        approvedBy[txId][msg.sender] = true;
        transactions[txId].approvals += 1;

        emit Approve(msg.sender, txId);
    }

    /// @notice Revoke a prior approval.
    function revoke(uint256 txId) external onlyOwner txExists(txId) notExecuted(txId) {
        if (!approvedBy[txId][msg.sender]) revert NotApproved(txId);

        approvedBy[txId][msg.sender] = false;
        transactions[txId].approvals -= 1;

        emit Revoke(msg.sender, txId);
    }

    /// @notice Execute a transaction if approvals meet the threshold.
    function execute(uint256 txId) external onlyOwner txExists(txId) notExecuted(txId) {
        Transaction storage txn = transactions[txId];
        if (txn.approvals < threshold) {
            revert InsufficientApprovals(txId, txn.approvals, threshold);
        }

        txn.executed = true;
        (bool ok, ) = txn.to.call{ value: txn.value }(txn.data);
        require(ok, 'Call failed');

        emit Execute(txId);
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function getTransaction(uint256 txId)
        external
        view
        returns (
            address to,
            uint256 value,
            bytes memory data,
            bool executed,
            uint256 approvals
        )
    {
        Transaction storage txn = transactions[txId];
        return (txn.to, txn.value, txn.data, txn.executed, txn.approvals);
    }
}
