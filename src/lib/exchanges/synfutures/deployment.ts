import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getCreate2Address,
  keccak256,
  padHex,
  parseAbi,
  stringToHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

// Safe's official v1.4.1 canonical Base deployments. Verify code, not just addresses.
// https://github.com/safe-global/safe-deployments/tree/main/src/assets/v1.4.1
export const SAFE_DEPLOYMENTS = {
  singleton: {
    address: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
    hash: "0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff",
  },
  factory: {
    address: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
    hash: "0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317",
  },
  createCall: {
    address: "0x9b35Af71d77eaf8d7e40252370304687390A1A52",
    hash: "0x2b3060c55fcb8275653e99ad511a71f67ba76934ed66a7d74d6e68b52afff889",
  },
} as const;

export const safeDeploymentAbi = parseAbi([
  "function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function VERSION() view returns (string)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)",
]);
export const factoryDeploymentAbi = parseAbi([
  "function proxyCreationCode() view returns (bytes)",
  "function createProxyWithNonce(address singleton,bytes initializer,uint256 saltNonce) returns (address proxy)",
]);
const createCallAbi = parseAbi([
  "function performCreate2(uint256 value,bytes deploymentData,bytes32 salt) returns (address newContract)",
]);

export type SynDeploymentPlan = {
  stage: "deploy_safe" | "deploy_module" | "deployed";
  chainId: 8453;
  owner: Address;
  safe: Address;
  module: Address;
  expiresAt: number;
  executionReady: false;
  pendingObservation?: {
    stage: "deploy_safe" | "deploy_module";
    hash: Hex;
    status: "unknown" | "included" | "reverted";
  };
  transaction: { from: Address; to: Address; value: "0x0"; data: Hex; chainId: "0x2105" } | null;
};

export function deploymentIdentity(
  ownerInput: string,
  walletId: string,
  proxyCreationCode: Hex,
  moduleCreationCode: Hex,
) {
  const owner = getAddress(ownerInput);
  if (owner === zeroAddress || !/^[0-9a-f-]{36}$/i.test(walletId))
    throw new Error("Invalid deployment owner.");
  const saltNonce = BigInt(
    keccak256(
      stringToHex(`turtlebot:synfutures:base:v1:${walletId.toLowerCase()}:${owner.toLowerCase()}`),
    ),
  );
  const initializer = encodeFunctionData({
    abi: safeDeploymentAbi,
    functionName: "setup",
    args: [[owner], 1n, zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress],
  });
  const salt = keccak256(
    concatHex([keccak256(initializer), padHex(`0x${saltNonce.toString(16)}`, { size: 32 })]),
  );
  const safe = getCreate2Address({
    from: SAFE_DEPLOYMENTS.factory.address,
    salt,
    bytecode: concatHex([
      proxyCreationCode,
      padHex(SAFE_DEPLOYMENTS.singleton.address, { size: 32 }),
    ]),
  });
  const moduleSalt = keccak256(stringToHex("turtlebot:synfutures:module:v1"));
  const moduleInitCode = concatHex([
    moduleCreationCode,
    encodeAbiParameters([{ type: "address" }], [safe]),
  ]);
  const module = getCreate2Address({ from: safe, salt: moduleSalt, bytecode: moduleInitCode });
  return { owner, safe, module, saltNonce, initializer, moduleSalt, moduleInitCode };
}

export function deploymentPlan(
  identity: ReturnType<typeof deploymentIdentity>,
  stage: SynDeploymentPlan["stage"],
  now = Date.now(),
): SynDeploymentPlan {
  const { owner, safe, module, saltNonce, initializer, moduleSalt, moduleInitCode } = identity;
  let transaction: SynDeploymentPlan["transaction"] = null;
  if (stage === "deploy_safe") {
    transaction = {
      from: owner,
      to: SAFE_DEPLOYMENTS.factory.address,
      value: "0x0",
      chainId: "0x2105",
      data: encodeFunctionData({
        abi: factoryDeploymentAbi,
        functionName: "createProxyWithNonce",
        args: [SAFE_DEPLOYMENTS.singleton.address, initializer, saltNonce],
      }),
    };
  } else if (stage === "deploy_module") {
    // A prevalidated signature works ONLY when the outer transaction is sent by
    // this Safe owner. No service key, remote signing, module enabling or funds.
    const signature = concatHex([padHex(owner, { size: 32 }), padHex("0x0", { size: 32 }), "0x01"]);
    const createData = encodeFunctionData({
      abi: createCallAbi,
      functionName: "performCreate2",
      args: [0n, moduleInitCode, moduleSalt],
    });
    transaction = {
      from: owner,
      to: safe,
      value: "0x0",
      chainId: "0x2105",
      data: encodeFunctionData({
        abi: safeDeploymentAbi,
        functionName: "execTransaction",
        args: [
          SAFE_DEPLOYMENTS.createCall.address,
          0n,
          createData,
          1,
          0n,
          0n,
          0n,
          zeroAddress,
          zeroAddress,
          signature,
        ],
      }),
    };
  }
  return {
    stage,
    chainId: 8453,
    owner,
    safe,
    module,
    expiresAt: now + 120_000,
    executionReady: false,
    transaction,
  };
}

export function assertDeploymentPlan(
  plan: SynDeploymentPlan,
  expectedOwner: string,
  now = Date.now(),
) {
  if (
    plan.chainId !== 8453 ||
    plan.executionReady !== false ||
    plan.expiresAt <= now ||
    plan.expiresAt > now + 125_000 ||
    getAddress(expectedOwner) !== getAddress(plan.owner)
  )
    throw new Error("Deployment review expired or wallet changed. Refresh it.");
  const tx = plan.transaction;
  if (
    !tx ||
    tx.value !== "0x0" ||
    tx.chainId !== "0x2105" ||
    getAddress(tx.from) !== getAddress(plan.owner) ||
    !/^0x[0-9a-f]+$/i.test(tx.data)
  )
    throw new Error("Invalid deployment transaction.");
  const expectedTo =
    plan.stage === "deploy_safe"
      ? SAFE_DEPLOYMENTS.factory.address
      : plan.stage === "deploy_module"
        ? plan.safe
        : zeroAddress;
  if (getAddress(tx.to) !== getAddress(expectedTo))
    throw new Error("Unexpected deployment target.");
}
