/**
 * E2E: Verify seed catalog matches on-chain state.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { SEED_MARKETS } from "@parlaycity/shared";
import { readAddresses, type DeployedAddresses } from "../helpers/addresses";
import { getPublicClient } from "../helpers/clients";
import { REGISTRY_ABI } from "../helpers/abis";

let addrs: DeployedAddresses;
let pub: ReturnType<typeof getPublicClient>;

beforeAll(() => {
  addrs = readAddresses();
  pub = getPublicClient();
});

describe("Catalog <-> on-chain consistency", () => {
  it("seed markets cover all expected categories", () => {
    const categories = new Set(SEED_MARKETS.map((m) => m.category));
    const expectedCats = [
      "crypto",
      "defi",
      "nft",
      "policy",
      "economics",
      "trivia",
      "ethdenver",
    ];
    for (const cat of expectedCats) {
      expect(categories.has(cat)).toBe(true);
    }

    const totalLegs = SEED_MARKETS.reduce(
      (sum, m) => sum + m.legs.length,
      0,
    );
    expect(totalLegs).toBe(21);
  });

  it("on-chain probabilities match seed catalog", async () => {
    const cryptoMarket = SEED_MARKETS.find((m) => m.category === "crypto");
    expect(cryptoMarket).toBeDefined();
    const leg1 = cryptoMarket!.legs[0];
    const leg2 = cryptoMarket!.legs[1];

    // Read on-chain legs and build question -> probabilityPPM map
    const count = await pub.readContract({
      address: addrs.LegRegistry,
      abi: REGISTRY_ABI,
      functionName: "legCount",
    });

    const onChainProbs = new Map<string, bigint>();
    for (let i = 0n; i < count; i++) {
      const leg = await pub.readContract({
        address: addrs.LegRegistry,
        abi: REGISTRY_ABI,
        functionName: "getLeg",
        args: [i],
      });
      onChainProbs.set(leg.question.trim().toLowerCase(), leg.probabilityPPM);
    }

    expect(onChainProbs.get(leg1.question.trim().toLowerCase())).toBe(
      BigInt(leg1.probabilityPPM),
    );
    expect(onChainProbs.get(leg2.question.trim().toLowerCase())).toBe(
      BigInt(leg2.probabilityPPM),
    );
  });
});
