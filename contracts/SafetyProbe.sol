// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Probe {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IPancakeRouterProbe {
    function WETH() external pure returns (address);

    function getAmountsOut(
        uint256 amountIn,
        address[] calldata path
    ) external view returns (uint256[] memory amounts);

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

/// @notice Destiné à être appelé avec eth_call pour simuler un aller-retour.
/// Une transaction réelle rembourse le BNB récupéré à l'appelant, mais elle ne doit pas être utilisée par le bot.
contract SafetyProbe {
    error BuyReturnedZeroToken();
    error NativeRefundFailed();

    receive() external payable {}

    function probe(
        address routerAddress,
        address token,
        uint256 deadline
    ) external payable returns (
        uint256 quotedTokens,
        uint256 receivedTokens,
        uint256 quotedNative,
        uint256 recoveredNative
    ) {
        require(msg.value > 0, "ZERO_VALUE");
        IPancakeRouterProbe router = IPancakeRouterProbe(routerAddress);
        IERC20Probe erc20 = IERC20Probe(token);

        address[] memory buyPath = new address[](2);
        buyPath[0] = router.WETH();
        buyPath[1] = token;
        quotedTokens = router.getAmountsOut(msg.value, buyPath)[1];

        uint256 tokenBefore = erc20.balanceOf(address(this));
        router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: msg.value}(
            0,
            buyPath,
            address(this),
            deadline
        );
        receivedTokens = erc20.balanceOf(address(this)) - tokenBefore;
        if (receivedTokens == 0) revert BuyReturnedZeroToken();

        erc20.approve(routerAddress, 0);
        erc20.approve(routerAddress, receivedTokens);

        address[] memory sellPath = new address[](2);
        sellPath[0] = token;
        sellPath[1] = router.WETH();
        quotedNative = router.getAmountsOut(receivedTokens, sellPath)[1];

        uint256 nativeBefore = address(this).balance;
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(
            receivedTokens,
            0,
            sellPath,
            address(this),
            deadline
        );
        recoveredNative = address(this).balance - nativeBefore;

        if (address(this).balance > 0) {
            (bool sent, ) = payable(msg.sender).call{value: address(this).balance}("");
            if (!sent) revert NativeRefundFailed();
        }
    }
}
