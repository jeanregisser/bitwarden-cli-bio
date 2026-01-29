import { describe, test, expect } from "vitest";
import { isPassthroughCommand } from "./passthrough";

describe("isPassthroughCommand", () => {
  describe("passthrough commands", () => {
    test.each([
      [["login"]],
      [["logout"]],
      [["lock"]],
      [["config"]],
      [["update"]],
      [["completion"]],
      [["status"]],
      [["serve"]],
    ])("%s is passthrough", (args) => {
      expect(isPassthroughCommand(args)).toBe(true);
    });

    test("status with flags is passthrough", () => {
      expect(isPassthroughCommand(["status", "--raw"])).toBe(true);
    });

    test("login with args is passthrough", () => {
      expect(isPassthroughCommand(["login", "--apikey"])).toBe(true);
    });
  });

  describe("passthrough flags", () => {
    test.each([[["--help"]], [["-h"]], [["--version"]], [["-v"]]])(
      "%s is passthrough",
      (args) => {
        expect(isPassthroughCommand(args)).toBe(true);
      }
    );

    test("help flag with command is passthrough", () => {
      expect(isPassthroughCommand(["get", "--help"])).toBe(true);
    });
  });

  describe("commands requiring unlock", () => {
    test.each([
      [["get", "password", "github"]],
      [["list", "items"]],
      [["sync"]],
      [["unlock"]],
      [["create", "item"]],
      [["edit", "item", "id"]],
      [["delete", "item", "id"]],
      [["generate"]],
      [["encode"]],
      [["export"]],
      [["import"]],
      [["send"]],
      [["receive"]],
    ])("%s needs unlock", (args) => {
      expect(isPassthroughCommand(args)).toBe(false);
    });
  });

  describe("edge cases", () => {
    test("no args is passthrough (shows help)", () => {
      expect(isPassthroughCommand([])).toBe(true);
    });

    test("unknown command is not passthrough", () => {
      expect(isPassthroughCommand(["unknown"])).toBe(false);
    });
  });
});
