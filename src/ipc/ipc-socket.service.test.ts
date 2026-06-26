import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getLinuxSocketPaths } from "./ipc-socket.service";

describe("getLinuxSocketPaths", () => {
  it("returns the XDG cache socket before the Flatpak Desktop socket", () => {
    expect(getLinuxSocketPaths("/home/alice", "/run/user/1000/cache")).toEqual([
      path.join("/run/user/1000/cache", "com.bitwarden.desktop", "s.bw"),
      path.join(
        "/home/alice",
        ".var",
        "app",
        "com.bitwarden.desktop",
        "cache",
        "com.bitwarden.desktop",
        "s.bw",
      ),
    ]);
  });

  it("falls back to the home cache directory when XDG_CACHE_HOME is unset", () => {
    expect(getLinuxSocketPaths("/home/alice")).toEqual([
      path.join("/home/alice", ".cache", "com.bitwarden.desktop", "s.bw"),
      path.join(
        "/home/alice",
        ".var",
        "app",
        "com.bitwarden.desktop",
        "cache",
        "com.bitwarden.desktop",
        "s.bw",
      ),
    ]);
  });
});
