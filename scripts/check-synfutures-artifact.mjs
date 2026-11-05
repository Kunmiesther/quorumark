import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

// Run after forge test/build. Do not silently refresh bytecode during CI.
const root = new URL("../", import.meta.url);
const build = JSON.parse(
  readFileSync(
    new URL(
      "contracts/synfutures/out/SynFuturesTradingModule.sol/SynFuturesTradingModule.json",
      root,
    ),
    "utf8",
  ),
);
const pinned = JSON.parse(
  readFileSync(new URL("src/lib/exchanges/synfutures/module-artifact.json", root), "utf8"),
);
const metadata = typeof build.metadata === "string" ? JSON.parse(build.metadata) : build.metadata;
assert.equal(pinned.compiler, metadata.compiler.version);
assert.equal(pinned.sourceHash, metadata.sources["src/SynFuturesTradingModule.sol"].keccak256);
assert.ok(
  pinned.creationBytecode === build.bytecode.object,
  "Creation bytecode differs from the pinned deployment artifact",
);
assert.ok(
  pinned.runtimeBytecode === build.deployedBytecode.object,
  "Runtime bytecode differs from the pinned deployment artifact",
);
assert.deepEqual(pinned.immutableReferences, build.deployedBytecode.immutableReferences);
console.log("Pinned SynFutures deployment bytecode matches the compiled module.");
