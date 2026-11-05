import { describe, expect, it } from "vitest";
import { accountWallets, connectedWallets } from "./accountIdentity";

const address = "0x99de0b7d790e378388ff48ceee5869466aef5631";
const wallet = {
  id: "wallet",
  public_address: address,
  status: "verified",
  is_active: true,
  assigned_exchange_connection_id: null,
};
const identities = ["apex", "aster"].map((connection_id) => ({
  connection_id,
  exchange: connection_id,
  account_address: address.toUpperCase().replace("0X", "0x"),
}));
describe("verified exchange account wallet matching", () => {
  it("matches the same MetaMask address to multiple exchanges without assignment writes", () => {
    expect(accountWallets([wallet], "apex", identities)).toEqual([wallet]);
    expect(accountWallets([wallet], "aster", identities)).toEqual([wallet]);
    expect(wallet.assigned_exchange_connection_id).toBeNull();
  });
  it("does not guess the only wallet when identity is unknown", () => {
    expect(connectedWallets([wallet], "aster", [])).toEqual([]);
  });
  it("rejects unverified or inactive address matches", () => {
    expect(
      accountWallets(
        [
          { ...wallet, status: "pending" },
          { ...wallet, is_active: false },
        ],
        "aster",
        identities,
      ),
    ).toEqual([]);
  });
  it("does not let a funding label override a conflicting account address", () => {
    const other = {
      ...wallet,
      public_address: "0x1111111111111111111111111111111111111111",
      assigned_exchange_connection_id: "aster",
    };
    expect(connectedWallets([other], "aster", identities)).toEqual([]);
  });
  it("retains explicit funding assignments where account identity is unavailable", () => {
    const assigned = { ...wallet, assigned_exchange_connection_id: "aster" };
    expect(connectedWallets([assigned], "aster", [])).toEqual([assigned]);
  });
});
