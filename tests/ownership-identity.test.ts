import { describe, expect, test } from "bun:test";
import {
  hasStarterVerifier,
  sameStarterIdentity,
  starterStillOwned,
  type BrokerOwnershipRecord,
  type OwnershipVerifier,
} from "../src/varlock/ownership.js";

const record: BrokerOwnershipRecord = {
  version: 2,
  brokerKeyHash: "hash",
  sessionUuid: "session",
  starterPid: 42,
  starterStartTime: "start",
  cwd: "/project",
  created: "now",
};
const verifier: OwnershipVerifier = {
  isAlive: async () => true,
  startTime: async () => "start",
  command: async () => ["varlock", "proxy", "start"],
  stop: async () => undefined,
};

describe("ownership starter identity", () => {
  test("requires all verifier methods and a recorded start time", () => {
    expect(hasStarterVerifier(record, verifier)).toBe(true);
    expect(hasStarterVerifier({ ...record, starterStartTime: undefined }, verifier)).toBe(false);
    expect(hasStarterVerifier(record, { ...verifier, command: undefined })).toBe(false);
  });

  test("accepts only a live process with matching start and command", () => {
    expect(sameStarterIdentity(true, "start", ["varlock", "proxy", "start"], "start")).toBe(true);
    expect(
      sameStarterIdentity(
        true,
        "start",
        [
          "/opt/homebrew/bin/varlock",
          "proxy",
          "start",
          "--allow-reload",
          "--cert-dir",
          "/tmp/cert",
        ],
        "start",
        ["/usr/local/bin/varlock"],
      ),
    ).toBe(true);
    expect(
      sameStarterIdentity(true, "start", ["other", "proxy", "start"], "start", ["varlock"]),
    ).toBe(false);
    expect(
      sameStarterIdentity(true, "start", ["varlock", "proxy", "stop"], "start", ["varlock"]),
    ).toBe(false);
    expect(
      sameStarterIdentity(true, "start", ["varlock", "other", "start"], "start", ["varlock"]),
    ).toBe(false);
    expect(sameStarterIdentity(false, "start", ["varlock", "proxy", "start"], "start")).toBe(false);
    expect(sameStarterIdentity(true, "other", ["varlock", "proxy", "start"], "start")).toBe(false);
    expect(sameStarterIdentity(true, "start", ["other"], "start")).toBe(false);
    expect(sameStarterIdentity(true, "start", undefined, "start")).toBe(false);
  });

  test("checks the live starter identity before reaping", async () => {
    expect(await starterStillOwned(record, verifier)).toBe(true);
    expect(
      await starterStillOwned(record, {
        ...verifier,
        isAlive: async () => false,
      }),
    ).toBe(false);
    expect(
      await starterStillOwned(record, {
        ...verifier,
        startTime: async () => "other",
      }),
    ).toBe(false);
  });
});
