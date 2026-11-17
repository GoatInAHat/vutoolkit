/**
 * Unmanaged (hand-written) coverage for handleInstall: background.test.ts is toolfactory-generated
 * and gets overwritten wholesale by `toolfactory build`, so the onInstalled handler added below
 * the tf:bg marker needs its own test file that survives a rebuild.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { handleInstall } from "../entrypoints/background";

describe("handleInstall", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it("flags a fresh install and opens the options page", async () => {
    const openOptionsPage = vi
      .spyOn(fakeBrowser.runtime, "openOptionsPage")
      .mockImplementation(async () => {});

    await handleInstall({ reason: "install" });

    expect((await fakeBrowser.storage.local.get("onboarded")).onboarded).toBe(false);
    expect(openOptionsPage).toHaveBeenCalledOnce();
  });

  it("leaves an update untouched", async () => {
    const openOptionsPage = vi
      .spyOn(fakeBrowser.runtime, "openOptionsPage")
      .mockImplementation(async () => {});

    await handleInstall({ reason: "update" });

    expect(await fakeBrowser.storage.local.get("onboarded")).toEqual({});
    expect(openOptionsPage).not.toHaveBeenCalled();
  });
});
