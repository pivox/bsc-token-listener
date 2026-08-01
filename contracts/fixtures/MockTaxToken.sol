// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockTaxToken {
    address public immutable router;
    uint256 public immutable buyTaxBps;
    uint256 public immutable sellTaxBps;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(address routerAddress, uint256 buyTax, uint256 sellTax) {
        require(buyTax <= 10_000 && sellTax <= 10_000, "INVALID_TAX");
        router = routerAddress;
        buyTaxBps = buyTax;
        sellTaxBps = sellTax;
        balanceOf[routerAddress] = type(uint128).max;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        uint256 tax = msg.sender == router ? buyTaxBps : 0;
        _transfer(msg.sender, to, amount, tax);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 currentAllowance = allowance[from][msg.sender];
        require(currentAllowance >= amount, "INSUFFICIENT_ALLOWANCE");
        allowance[from][msg.sender] = currentAllowance - amount;
        uint256 tax = to == router ? sellTaxBps : 0;
        _transfer(from, to, amount, tax);
        return true;
    }

    function _transfer(address from, address to, uint256 amount, uint256 taxBps) private {
        require(balanceOf[from] >= amount, "INSUFFICIENT_BALANCE");
        uint256 received = amount - ((amount * taxBps) / 10_000);
        balanceOf[from] -= amount;
        balanceOf[to] += received;
    }
}
