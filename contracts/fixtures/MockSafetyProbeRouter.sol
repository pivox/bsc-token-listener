// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IMockRouterToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract MockSafetyProbeRouter {
    error Expired();
    error InvalidPath();
    error TokenTransferFailed();
    error NativeTransferFailed();

    address private constant WRAPPED_NATIVE = address(0xBEEF);

    function WETH() external pure returns (address) {
        return WRAPPED_NATIVE;
    }

    function getAmountsOut(
        uint256 amountIn,
        address[] calldata path
    ) external pure returns (uint256[] memory amounts) {
        if (path.length != 2) revert InvalidPath();
        bool isBuy = path[0] == WRAPPED_NATIVE && path[1] != WRAPPED_NATIVE;
        bool isSell = path[0] != WRAPPED_NATIVE && path[1] == WRAPPED_NATIVE;
        if (!isBuy && !isSell) revert InvalidPath();
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountIn;
    }

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable {
        if (deadline < block.timestamp) revert Expired();
        if (
            path.length != 2 ||
            path[0] != WRAPPED_NATIVE ||
            path[1] == WRAPPED_NATIVE
        ) revert InvalidPath();
        if (!IMockRouterToken(path[1]).transfer(to, msg.value)) {
            revert TokenTransferFailed();
        }
    }

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external {
        if (deadline < block.timestamp) revert Expired();
        if (
            path.length != 2 ||
            path[0] == WRAPPED_NATIVE ||
            path[1] != WRAPPED_NATIVE
        ) revert InvalidPath();
        IMockRouterToken token = IMockRouterToken(path[0]);
        uint256 balanceBefore = token.balanceOf(address(this));
        if (!token.transferFrom(msg.sender, address(this), amountIn)) {
            revert TokenTransferFailed();
        }
        uint256 received = token.balanceOf(address(this)) - balanceBefore;
        (bool sent, ) = payable(to).call{value: received}("");
        if (!sent) revert NativeTransferFailed();
    }
}
