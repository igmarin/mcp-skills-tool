import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  determineReviewState,
  parseMetadataBlock,
  evaluateFeedbackFallback,
  submitPRReview,
  sys,
  getEnvConfig,
  fetchGithubApi,
  fetchBotFeedback,
  dismissPreviousChangesRequested,
  main,
} from "./evaluate-review.js";

describe("parseMetadataBlock", () => {
  it("should parse metadata block correctly", () => {
    const botItems = [
      {
        body: `Some comments here...\n[OPENCODE_VERDICT_METADATA]\nVerdict: NEGATIVE\nCriticalBugs: 3\nSecurityIssues: 1`,
        user: "github-actions[bot]",
      },
    ];
    const result = parseMetadataBlock(botItems);
    expect(result).toEqual({
      verdict: "NEGATIVE",
      criticalBugs: 3,
      securityIssues: 1,
    });
  });

  it("should return null if no metadata block exists", () => {
    const botItems = [{ body: "Just a simple comment", user: "github-actions[bot]" }];
    expect(parseMetadataBlock(botItems)).toBeNull();
  });
});

describe("evaluateFeedbackFallback", () => {
  it("should count tags correctly", () => {
    const botItems = [
      { body: "Fix this [Critical Bug]", user: "github-actions[bot]" },
      { body: "Security leak here [Security] and here [Security]", user: "github-actions[bot]" },
    ];
    const result = evaluateFeedbackFallback(botItems);
    expect(result).toEqual({
      verdict: "NEGATIVE",
      criticalBugs: 1,
      securityIssues: 2,
    });
  });
});

describe("determineReviewState", () => {
  it("should request changes for negative verdict, security issues, or >2 critical bugs", () => {
    expect(determineReviewState("NEGATIVE", 0, 0).targetState).toBe("REQUEST_CHANGES");
    expect(determineReviewState("POSITIVE", 0, 1).targetState).toBe("REQUEST_CHANGES");
    expect(determineReviewState("POSITIVE", 3, 0).targetState).toBe("REQUEST_CHANGES");
    expect(determineReviewState("NEGATIVE", 0, 0).message).toContain("❌");
  });

  it("should approve for any verdict with 0 bugs and 0 security issues", () => {
    expect(determineReviewState("POSITIVE", 0, 0).targetState).toBe("APPROVE");
    expect(determineReviewState("NEUTRAL", 0, 0).targetState).toBe("APPROVE");
    expect(determineReviewState("POSITIVE", 0, 0).message).toContain("✅");
  });

  it("should comment when there are 1-2 critical bugs and 0 security issues", () => {
    expect(determineReviewState("POSITIVE", 2, 0).targetState).toBe("COMMENT");
    expect(determineReviewState("NEUTRAL", 1, 0).targetState).toBe("COMMENT");
    expect(determineReviewState("POSITIVE", 2, 0).message).toContain("💬");
  });
});

describe("submitPRReview", () => {
  let execSyncSpy;

  beforeEach(() => {
    vi.restoreAllMocks();
    execSyncSpy = vi.spyOn(sys, "execSync").mockImplementation(() => Buffer.from(""));
  });

  it("should successfully call execSync with approve flag", () => {
    submitPRReview("5", "APPROVE", "Looks good");
    expect(execSyncSpy).toHaveBeenCalledWith('gh pr review 5 --approve -b "Looks good"');
  });

  it("should throw an error for invalid PR numbers", () => {
    expect(() => submitPRReview("abc", "APPROVE", "Looks good")).toThrow("Invalid PR number: abc");
    expect(() => submitPRReview("5; rm -rf /", "APPROVE", "Looks good")).toThrow(
      "Invalid PR number: 5; rm -rf /",
    );
    expect(execSyncSpy).not.toHaveBeenCalled();
  });

  it("should escape shell metacharacters in the message", () => {
    submitPRReview("42", "COMMENT", 'Hello `world` $HOME "test"');
    expect(execSyncSpy).toHaveBeenCalledWith(
      'gh pr review 42 --comment -b "Hello \\`world\\` \\$HOME \\"test\\""',
    );
  });

  it("should fallback to comment if approve fails with a permission error", () => {
    execSyncSpy.mockImplementationOnce(() => {
      const err = new Error("Command failed: gh pr review 5 --approve");
      err.stderr = Buffer.from(
        "GraphQL: GitHub Actions is not permitted to approve pull requests. (addPullRequestReview)",
      );
      throw err;
    });

    submitPRReview("5", "APPROVE", "Looks good");

    expect(execSyncSpy).toHaveBeenCalledTimes(2);
    expect(execSyncSpy).toHaveBeenNthCalledWith(1, 'gh pr review 5 --approve -b "Looks good"');
    expect(execSyncSpy).toHaveBeenNthCalledWith(
      2,
      'gh pr review 5 --comment -b "⚠️ [Bot fallback from APPROVE] Looks good"',
    );
  });

  it("should escape shell metacharacters in fallback message", () => {
    execSyncSpy.mockImplementationOnce(() => {
      const err = new Error("Command failed: gh pr review 5 --approve");
      err.stderr = Buffer.from(
        "GraphQL: GitHub Actions is not permitted to approve pull requests. (addPullRequestReview)",
      );
      throw err;
    });

    submitPRReview("5", "APPROVE", 'Hello `world` $HOME "test"');

    expect(execSyncSpy).toHaveBeenCalledTimes(2);
    expect(execSyncSpy).toHaveBeenNthCalledWith(
      2,
      'gh pr review 5 --comment -b "⚠️ [Bot fallback from APPROVE] Hello \\`world\\` \\$HOME \\"test\\""',
    );
  });

  it("should rethrow error if approve fails with non-permission error", () => {
    execSyncSpy.mockImplementationOnce(() => {
      throw new Error("Some other random error");
    });

    expect(() => submitPRReview("5", "APPROVE", "Looks good")).toThrow("Some other random error");
    expect(execSyncSpy).toHaveBeenCalledTimes(1);
  });
});

describe("getEnvConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should return PR_NUMBER and GITHUB_REPOSITORY when set", () => {
    process.env.PR_NUMBER = "42";
    process.env.GITHUB_REPOSITORY = "owner/repo";

    const result = getEnvConfig();
    expect(result).toEqual({ prNumber: "42", repo: "owner/repo" });
  });

  it("should throw an error when environment variables are missing", () => {
    delete process.env.PR_NUMBER;
    delete process.env.GITHUB_REPOSITORY;

    expect(() => getEnvConfig()).toThrow(
      "Missing PR_NUMBER or GITHUB_REPOSITORY environment variables.",
    );
  });
});

describe("fetchGithubApi", () => {
  let execSyncSpy;

  beforeEach(() => {
    vi.restoreAllMocks();
    execSyncSpy = vi.spyOn(sys, "execSync").mockImplementation(() => Buffer.from('{"data": true}'));
  });

  it("should fetch and parse JSON from gh api", () => {
    const result = fetchGithubApi("repos/owner/repo/issues/1/comments");
    expect(result).toEqual({ data: true });
    expect(execSyncSpy).toHaveBeenCalledWith("gh api repos/owner/repo/issues/1/comments");
  });

  it("should throw a wrapped error when gh api fails", () => {
    execSyncSpy.mockImplementationOnce(() => {
      throw new Error("network error");
    });

    expect(() => fetchGithubApi("bad/endpoint")).toThrow(
      "Failed to fetch GitHub API endpoint 'bad/endpoint': network error",
    );
  });
});

describe("fetchBotFeedback", () => {
  let execSyncSpy;

  beforeEach(() => {
    vi.restoreAllMocks();
    execSyncSpy = vi.spyOn(sys, "execSync").mockImplementation((cmd) => {
      if (cmd.includes("/issues/")) {
        return Buffer.from(
          JSON.stringify([
            {
              body: "issue comment",
              created_at: "2024-01-02T00:00:00Z",
              user: { login: "github-actions[bot]" },
            },
            { body: "ignored", created_at: "2024-01-01T00:00:00Z", user: { login: "some-user" } },
          ]),
        );
      }
      if (cmd.includes("/pulls/") && cmd.includes("/comments")) {
        return Buffer.from(
          JSON.stringify([
            {
              body: "review comment",
              created_at: "2024-01-03T00:00:00Z",
              user: { login: "opencode-bot" },
            },
          ]),
        );
      }
      if (cmd.includes("/reviews")) {
        return Buffer.from(
          JSON.stringify([
            {
              body: "review body",
              submitted_at: "2024-01-04T00:00:00Z",
              user: { login: "opencode-bot" },
            },
          ]),
        );
      }
      return Buffer.from("[]");
    });
  });

  it("should fetch and filter bot comments sorted by date", () => {
    const result = fetchBotFeedback("owner/repo", "1");
    expect(result).toHaveLength(3);
    expect(result[0].body).toBe("review body");
    expect(result[1].body).toBe("review comment");
    expect(result[2].body).toBe("issue comment");
  });

  it("should return empty array when no bot feedback exists", () => {
    execSyncSpy.mockImplementation(() => Buffer.from("[]"));
    const result = fetchBotFeedback("owner/repo", "1");
    expect(result).toHaveLength(0);
  });

  it("should skip comments from deleted users (null user)", () => {
    execSyncSpy.mockImplementation((cmd) => {
      if (cmd.includes("/issues/")) {
        return Buffer.from(
          JSON.stringify([
            { body: "from deleted user", created_at: "2024-01-01T00:00:00Z", user: null },
            {
              body: "valid comment",
              created_at: "2024-01-02T00:00:00Z",
              user: { login: "github-actions[bot]" },
            },
          ]),
        );
      }
      if (cmd.includes("/pulls/") && cmd.includes("/comments")) {
        return Buffer.from(
          JSON.stringify([
            { body: "deleted review comment", created_at: "2024-01-03T00:00:00Z", user: null },
          ]),
        );
      }
      if (cmd.includes("/reviews")) {
        return Buffer.from(
          JSON.stringify([
            { body: "deleted review", submitted_at: "2024-01-04T00:00:00Z", user: null },
          ]),
        );
      }
      return Buffer.from("[]");
    });

    const result = fetchBotFeedback("owner/repo", "1");
    expect(result).toHaveLength(1);
    expect(result[0].body).toBe("valid comment");
  });
});

describe("dismissPreviousChangesRequested", () => {
  let execSyncSpy;
  let consoleWarnSpy;

  beforeEach(() => {
    vi.restoreAllMocks();
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    execSyncSpy = vi.spyOn(sys, "execSync").mockImplementation(() => Buffer.from("[]"));
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it("should dismiss previous bot CHANGES_REQUESTED reviews", () => {
    execSyncSpy.mockImplementationOnce(() =>
      Buffer.from(
        JSON.stringify([
          { id: 123, state: "CHANGES_REQUESTED", user: { login: "opencode-bot" } },
          { id: 456, state: "APPROVED", user: { login: "opencode-bot" } },
          { id: 789, state: "CHANGES_REQUESTED", user: { login: "human-reviewer" } },
        ]),
      ),
    );

    dismissPreviousChangesRequested("owner/repo", "1");

    expect(execSyncSpy).toHaveBeenCalledTimes(2);
    expect(execSyncSpy).toHaveBeenNthCalledWith(
      2,
      'gh api -X PUT repos/owner/repo/pulls/1/reviews/123/dismissals -f message="Dismissed previous blocking review because the blocking criteria is no longer met."',
    );
  });

  it("should warn and not throw when dismissing fails", () => {
    execSyncSpy.mockImplementationOnce(() => {
      throw new Error("API error");
    });

    expect(() => dismissPreviousChangesRequested("owner/repo", "1")).not.toThrow();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to dismiss previous reviews"),
    );
  });
});

describe("main", () => {
  let execSyncSpy;
  let consoleWarnSpy;
  let consoleErrorSpy;
  let exitSpy;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv, PR_NUMBER: "99", GITHUB_REPOSITORY: "owner/repo" };
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});
    execSyncSpy = vi.spyOn(sys, "execSync").mockImplementation((cmd) => {
      if (cmd.includes("/issues/") || cmd.includes("/comments") || cmd.includes("/reviews")) {
        return Buffer.from("[]");
      }
      if (cmd.includes("gh pr review")) {
        return Buffer.from("");
      }
      return Buffer.from("[]");
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("should exit cleanly when no bot feedback is found", () => {
    main();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "No feedback from bot found. Exiting review evaluation.",
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("should submit an APPROVE review when no issues found", () => {
    execSyncSpy.mockImplementation((cmd) => {
      if (cmd.includes("/issues/")) {
        return Buffer.from(
          JSON.stringify([
            {
              body: "LGTM",
              created_at: "2024-01-01T00:00:00Z",
              user: { login: "github-actions[bot]" },
            },
          ]),
        );
      }
      if (cmd.includes("/pulls/") && cmd.includes("/comments")) {
        return Buffer.from("[]");
      }
      if (cmd.includes("/reviews")) {
        return Buffer.from("[]");
      }
      if (cmd.includes("gh pr review")) {
        return Buffer.from("");
      }
      return Buffer.from("[]");
    });

    main();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Successfully submitted PR review status!"),
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("should exit with code 1 on unhandled errors", () => {
    delete process.env.PR_NUMBER;
    main();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Execution failed:",
      "Missing PR_NUMBER or GITHUB_REPOSITORY environment variables.",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
