import { describe, expect, it } from "vitest";
import { getFingerprint } from "./fingerprint";

describe("getFingerprint", () => {
  it("returns a stable word phrase for a given input", () => {
    const publicKey = Buffer.from("test-public-key");
    const phrase = getFingerprint("test-app-id", publicKey);

    expect(phrase).toHaveLength(5);
    expect(phrase.every((w) => typeof w === "string" && w.length > 0)).toBe(
      true,
    );
    // Pin the exact output to detect algorithm regressions
    expect(phrase.join("-")).toBe("carve-bulldozer-retake-bath-crust");
  });

  it("produces different phrases for different fingerprint material", () => {
    const publicKey = Buffer.from("test-public-key");
    const a = getFingerprint("app-a", publicKey);
    const b = getFingerprint("app-b", publicKey);

    expect(a.join("-")).not.toBe(b.join("-"));
  });
});
