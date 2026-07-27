// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20Probe {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IPancakeRouterProbe {
    function WETH() external view returns (address);

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable;

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/// @notice Simule un aller-retour BNB -> token -> BNB.
/// @dev La fonction termine TOUJOURS par un revert ProbeResult. Une transaction réelle
///      ne peut donc pas laisser de fonds ou d'approbations dans ce contrat; seul le gas serait perdu.
contract SafetyProbe {
    error InvalidInput();
    error BuyReturnedZeroToken();
    error ApproveFailed();
    error ProbeResult(uint256 tokensBought, uint256 bnbRecovered);

    receive() external payable {}

    function probe(address routerAddress, address token, uint256 deadline) external payable {
        if (routerAddress == address(0) || token == address(0) || msg.value == 0) {
            revert InvalidInput();
        }

        IPancakeRouterProbe router = IPancakeRouterProbe(routerAddress);
        address wrappedBnb = router.WETH();

        address[] memory buyPath = new address[](2);
        buyPath[0] = wrappedBnb;
        buyPath[1] = token;

        uint256 tokenBefore = IERC20Probe(token).balanceOf(address(this));
        router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: msg.value}(
            0,
            buyPath,
            address(this),
            deadline
        );
        uint256 tokensBought = IERC20Probe(token).balanceOf(address(this)) - tokenBefore;
        if (tokensBought == 0) {
            revert BuyReturnedZeroToken();
        }

        _forceApprove(token, routerAddress, tokensBought);

        address[] memory sellPath = new address[](2);
        sellPath[0] = token;
        sellPath[1] = wrappedBnb;

        uint256 bnbBefore = address(this).balance;
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(
            tokensBought,
            0,
            sellPath,
            address(this),
            deadline
        );
        uint256 bnbRecovered = address(this).balance - bnbBefore;

        revert ProbeResult(tokensBought, bnbRecovered);
    }

    function _forceApprove(address token, address spender, uint256 amount) private {
        if (_callApprove(token, spender, amount)) {
            return;
        }
        if (!_callApprove(token, spender, 0) || !_callApprove(token, spender, amount)) {
            revert ApproveFailed();
        }
    }

    function _callApprove(address token, address spender, uint256 amount) private returns (bool) {
        (bool success, bytes memory data) = token.call(
            abi.encodeCall(IERC20Probe.approve, (spender, amount))
        );
        return success && (data.length == 0 || abi.decode(data, (bool)));
    }
}
