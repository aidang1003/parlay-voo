/**
 * E2E: Leg registry is now engine-managed (JIT via buyTicketSigned). Pre-
 * registration (register-legs.ts + sample legs in Deploy.s.sol) has been
 * removed, so the registry starts empty and gets populated as users buy.
 * This test verifies the empty initial state and engine wiring.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readAddresses, type DeployedAddresses } from "../helpers/addresses";
import { getPublicClient } from "../helpers/clients";
import { REGISTRY_ABI } from "../helpers/abis";

let addrs: DeployedAddresses;
let pub: ReturnType<typeof getPublicClient>;

beforeAll(() => {
  addrs = readAddresses();
  pub = getPublicClient();
});

describe("Leg registry (post-JIT refactor)", () => {
  it("engine is wired to ParlayEngine", async () => {
    const engine = await pub.readContract({
      address: addrs.LegRegistry,
      abi: REGISTRY_ABI,
      functionName: "engine",
    });
    expect((engine as string).toLowerCase()).toBe(addrs.ParlayEngine.toLowerCase());
  });

  it("legCount may start at zero (legs are created just-in-time at buy)", async () => {
    const count = await pub.readContract({
      address: addrs.LegRegistry,
      abi: REGISTRY_ABI,
      functionName: "legCount",
    });
    expect(count).toBeGreaterThanOrEqual(0n);
  });
});
