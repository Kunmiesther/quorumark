// @vitest-environment node
import { expect, it, vi } from "vitest";
const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  connect: vi
    .fn()
    .mockResolvedValue({
      accounts: ["0x1111111111111111111111111111111111111111"],
      chainId: "0x1",
    }),
}));
vi.mock("@metamask/connect-evm", () => ({ createEVMClient: sdk.create }));
import { connectMetaMask } from "./metamask-connect";
it("supports Base RPC without changing the existing Ethereum connect permissions", async () => {
  sdk.create.mockResolvedValue({ connect: sdk.connect });
  await connectMetaMask();
  expect(sdk.create).toHaveBeenCalledWith(
    expect.objectContaining({
      api: {
        supportedNetworks: {
          "0x1": "https://ethereum-rpc.publicnode.com",
          "0x2105": "https://mainnet.base.org",
        },
      },
    }),
  );
  expect(sdk.connect).toHaveBeenCalledWith({ chainIds: ["0x1"], forceRequest: true });
});
