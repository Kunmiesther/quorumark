// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "./SynFuturesSafe.t.sol";

interface IDeploymentFactory {
    function proxyCreationCode() external pure returns (bytes memory);
    function createProxyWithNonce(address, bytes calldata, uint256) external returns (address);
}

interface ICreateCall {
    function performCreate2(uint256, bytes calldata, bytes32) external returns (address);
}

contract SynFuturesDeploymentTest {
    VmSafe internal constant vm = VmSafe(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant OWNER = 0x1111111111111111111111111111111111111111;
    address internal constant SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant CREATE_CALL = 0x9b35Af71d77eaf8d7e40252370304687390A1A52;

    function _install(address target, string memory path) internal {
        bytes memory code = vm.getCode(path);
        address deployed;
        assembly { deployed := create(0, add(code, 32), mload(code)) }
        require(deployed != address(0));
        vm.etch(target, deployed.code);
    }

    function testOwnerDeterministicDeploymentDoesNotEnableTrading() public {
        vm.chainId(8453);
        vm.etch(0x208B443983D8BcC8578e9D86Db23FbA547071270, hex"00");
        vm.etch(0xDb166a6E454d2a273Cd50CCD6420703564B2a830, address(new ObserverHarness()).code);
        _install(SINGLETON, "node_modules/@safe-global/safe-contracts/build/artifacts/contracts/SafeL2.sol/SafeL2.json");
        _install(
            FACTORY,
            "node_modules/@safe-global/safe-contracts/build/artifacts/contracts/proxies/SafeProxyFactory.sol/SafeProxyFactory.json"
        );
        _install(
            CREATE_CALL,
            "node_modules/@safe-global/safe-contracts/build/artifacts/contracts/libraries/CreateCall.sol/CreateCall.json"
        );
        address[] memory owners = new address[](1);
        owners[0] = OWNER;
        bytes memory initializer = abi.encodeCall(
            IRealSafe.setup, (owners, 1, address(0), bytes(""), address(0), address(0), 0, payable(address(0)))
        );
        uint256 saltNonce = uint256(
            keccak256(
                "turtlebot:synfutures:base:v1:00000000-0000-4000-8000-000000000001:0x1111111111111111111111111111111111111111"
            )
        );
        bytes32 salt = keccak256(abi.encodePacked(keccak256(initializer), saltNonce));
        bytes32 safeInitHash =
            keccak256(abi.encodePacked(IDeploymentFactory(FACTORY).proxyCreationCode(), uint256(uint160(SINGLETON))));
        address predicted = address(uint160(uint256(keccak256(abi.encodePacked(hex"ff", FACTORY, salt, safeInitHash)))));
        vm.prank(OWNER);
        address deployed = IDeploymentFactory(FACTORY).createProxyWithNonce(SINGLETON, initializer, saltNonce);
        require(deployed == predicted && IRealSafe(deployed).getOwners()[0] == OWNER);
        bytes memory initCode = abi.encodePacked(type(SynFuturesTradingModule).creationCode, abi.encode(deployed));
        bytes32 moduleSalt = keccak256("turtlebot:synfutures:module:v1");
        address predictedModule =
            address(uint160(uint256(keccak256(abi.encodePacked(hex"ff", deployed, moduleSalt, keccak256(initCode))))));
        bytes memory signature = abi.encodePacked(bytes32(uint256(uint160(OWNER))), bytes32(0), uint8(1));
        bytes memory data = abi.encodeCall(ICreateCall.performCreate2, (0, initCode, moduleSalt));
        // A remote service cannot use the owner's prevalidated signature.
        vm.expectRevert();
        IRealSafe(deployed)
            .execTransaction(CREATE_CALL, 0, data, 1, 0, 0, 0, address(0), payable(address(0)), signature);
        vm.prank(OWNER);
        require(
            IRealSafe(deployed)
                .execTransaction(CREATE_CALL, 0, data, 1, 0, 0, 0, address(0), payable(address(0)), signature)
        );
        SynFuturesTradingModule module = SynFuturesTradingModule(predictedModule);
        require(predictedModule.code.length > 0 && module.safe() == deployed);
        require(!IRealSafe(deployed).isModuleEnabled(predictedModule));
        (address operator,,,,) = module.session();
        require(operator == address(0));
        require(deployed.balance == 0 && predictedModule.balance == 0);
    }
}
