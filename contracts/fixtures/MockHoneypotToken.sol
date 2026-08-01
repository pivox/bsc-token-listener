// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockHoneypotToken {
    error SellBlocked();

    address public immutable router;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(address routerAddress) {
        router = routerAddress;
        balanceOf[routerAddress] = type(uint128).max;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (to == router) revert SellBlocked();
        uint256 currentAllowance = allowance[from][msg.sender];
        require(currentAllowance >= amount, "INSUFFICIENT_ALLOWANCE");
        allowance[from][msg.sender] = currentAllowance - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "INSUFFICIENT_BALANCE");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}
