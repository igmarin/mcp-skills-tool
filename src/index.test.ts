import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the CLI module so importing the shim never touches real stdio or a real
// server. The mocks are hoisted so the factory can reference them safely.
const { runCliMock, reportFatalErrorMock } = vi.hoisted(() => ({
  runCliMock: vi.fn(),
  reportFatalErrorMock: vi.fn(),
}));

vi.mock("./cli.js", () => ({
  runCli: runCliMock,
  reportFatalError: reportFatalErrorMock,
}));

describe("index.ts shim", () => {
  beforeEach(() => {
    vi.resetModules();
    runCliMock.mockReset();
    reportFatalErrorMock.mockReset();
  });

  it("invokes runCli on startup", async () => {
    runCliMock.mockResolvedValue(undefined);

    await import("./index.js");

    expect(runCliMock).toHaveBeenCalledTimes(1);
    expect(reportFatalErrorMock).not.toHaveBeenCalled();
  });

  it("maps a runCli failure to a process exit via reportFatalError", async () => {
    const error = new Error("boom");
    runCliMock.mockRejectedValue(error);
    reportFatalErrorMock.mockReturnValue(1);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await import("./index.js");

    await vi.waitFor(() => {
      expect(reportFatalErrorMock).toHaveBeenCalledWith(error);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    exitSpy.mockRestore();
  });
});
