import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

export const sys = {
  execSync: (cmd) => execSync(cmd)
};

/**
 * Validates and retrieves required environment variables.
 * @returns {{ prNumber: string, repo: string }}
 */
export function getEnvConfig() {
  const prNumber = process.env.PR_NUMBER;
  const repo = process.env.GITHUB_REPOSITORY;

  if (!prNumber || !repo) {
    throw new Error("Missing PR_NUMBER or GITHUB_REPOSITORY environment variables.");
  }

  return { prNumber, repo };
}

/**
 * Executes a GitHub CLI API command and parses the JSON response.
 * @param {string} endpoint
 * @returns {unknown}
 */
export function fetchGithubApi(endpoint) {
  try {
    const output = sys.execSync(`gh api ${endpoint}`).toString();
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`Failed to fetch GitHub API endpoint '${endpoint}': ${error.message}`);
  }
}

/**
 * Retrieves and combines all comments & reviews left by the OpenCode / GitHub Actions bot.
 * Sorted newest first.
 * @param {string} repo
 * @param {string} prNumber
 * @returns {Array<{ body: string, created_at: string, user: string }>}
 */
export function fetchBotFeedback(repo, prNumber) {
  console.warn(`Fetching comments and reviews for PR #${prNumber} in ${repo}...`);

  const issueComments = fetchGithubApi(`repos/${repo}/issues/${prNumber}/comments`);
  const reviewComments = fetchGithubApi(`repos/${repo}/pulls/${prNumber}/comments`);
  const reviews = fetchGithubApi(`repos/${repo}/pulls/${prNumber}/reviews`);

  const allItems = [
    ...issueComments.map(c => ({ body: c.body, created_at: c.created_at, user: c.user.login })),
    ...reviewComments.map(c => ({ body: c.body, created_at: c.created_at, user: c.user.login })),
    ...reviews.map(r => ({ body: r.body, created_at: r.submitted_at, user: r.user.login }))
  ];

  return allItems
    .filter(item => {
      const login = item.user.toLowerCase();
      return login === 'github-actions[bot]' || login.includes('opencode');
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

/**
 * Attempts to parse the latest verdict metadata block from bot feedback.
 * @param {Array<object>} botItems
 * @returns {{ verdict: string, criticalBugs: number, securityIssues: number } | null}
 */
export function parseMetadataBlock(botItems) {
  const metadataRegex = /\[OPENCODE_VERDICT_METADATA\][\s\S]*?Verdict:\s*(\w+)[\s\S]*?CriticalBugs:\s*(\d+)[\s\S]*?SecurityIssues:\s*(\d+)/;

  for (const item of botItems) {
    if (!item.body) {
      continue;
    }
    const match = item.body.match(metadataRegex);
    if (match) {
      return {
        verdict: match[1].toUpperCase(),
        criticalBugs: parseInt(match[2], 10),
        securityIssues: parseInt(match[3], 10)
      };
    }
  }

  return null;
}

/**
 * Counts occurrences of bug and security tags in bot items as a fallback.
 * @param {Array<object>} botItems
 * @returns {{ verdict: string, criticalBugs: number, securityIssues: number }}
 */
export function evaluateFeedbackFallback(botItems) {
  console.warn("No explicit metadata block found. Falling back to tag counting...");

  let criticalBugs = 0;
  let securityIssues = 0;

  for (const item of botItems) {
    if (!item.body) {
      continue;
    }
    const bugMatches = item.body.match(/\[Critical Bug\]/gi);
    if (bugMatches) {
      criticalBugs += bugMatches.length;
    }

    const secMatches = item.body.match(/\[Security\]/gi);
    if (secMatches) {
      securityIssues += secMatches.length;
    }
  }

  const verdict = (criticalBugs > 0 || securityIssues > 0) ? 'NEGATIVE' : 'POSITIVE';
  return { verdict, criticalBugs, securityIssues };
}

/**
 * Evaluates the parsed/counted issues to decide the final review state.
 * @param {string} verdict
 * @param {number} criticalBugs
 * @param {number} securityIssues
 * @returns {{ targetState: 'REQUEST_CHANGES' | 'APPROVE' | 'COMMENT', message: string }}
 */
export function determineReviewState(verdict, criticalBugs, securityIssues) {
  if (verdict === 'NEGATIVE' || securityIssues > 0 || criticalBugs > 2) {
    return {
      targetState: 'REQUEST_CHANGES',
      message: `OpenCode Review: Changes Requested. Found ${securityIssues} security issue(s) and ${criticalBugs} critical bug(s). Please review and address these issues.`
    };
  }

  if (criticalBugs === 0 && securityIssues === 0) {
    return {
      targetState: 'APPROVE',
      message: `OpenCode Review: Approved! No critical bugs or security issues found. Everything looks good!`
    };
  }

  return {
    targetState: 'COMMENT',
    message: `OpenCode Review: Comments left. Minor feedback or optimization suggestions provided (Critical Bugs: ${criticalBugs}).`
  };
}

/**
 * Submits the PR review with the specified state and message using the GitHub CLI.
 * @param {string} prNumber
 * @param {string} state
 * @param {string} message
 */
export function submitPRReview(prNumber, state, message) {
  if (!/^\d+$/.test(prNumber)) {
    throw new Error(`Invalid PR number: ${prNumber}`);
  }

  const flags = {
    'REQUEST_CHANGES': '--request-changes',
    'APPROVE': '--approve',
    'COMMENT': '--comment'
  };

  const stateFlag = flags[state] || '--comment';
  const escapedMessage = message
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');

  const ghCommand = `gh pr review ${prNumber} ${stateFlag} -b "${escapedMessage}"`;

  console.warn(`Submitting review state (${state}): ${ghCommand}`);
  try {
    sys.execSync(ghCommand);
  } catch (error) {
    const stderr = error.stderr ? error.stderr.toString() : '';
    const stdout = error.stdout ? error.stdout.toString() : '';
    const errorMsg = `${error.message}\n${stdout}\n${stderr}`;

    if (state !== 'COMMENT' && (errorMsg.includes('not permitted') || errorMsg.includes('GraphQL:') || errorMsg.includes('permission'))) {
      console.warn(`Warning: Failed to submit review as ${state} due to permission constraints. Falling back to COMMENT review.`);
      const fallbackMessage = `[Bot fallback from ${state}] ${message}`;
      const escapedFallback = fallbackMessage.replace(/"/g, '\\"');
      const fallbackCommand = `gh pr review ${prNumber} --comment -b "${escapedFallback}"`;
      console.warn(`Submitting fallback review: ${fallbackCommand}`);
      try {
        sys.execSync(fallbackCommand);
      } catch (fallbackError) {
        throw new Error(`Failed to submit fallback review: ${fallbackError.message}`);
      }
    } else {
      throw error;
    }
  }
}

/**
 * Dismisses any previous CHANGES_REQUESTED reviews left by the bot.
 * @param {string} repo
 * @param {string} prNumber
 */
export function dismissPreviousChangesRequested(repo, prNumber) {
  try {
    const reviewsJson = sys.execSync(`gh api repos/${repo}/pulls/${prNumber}/reviews`).toString();
    const reviews = JSON.parse(reviewsJson);
    const botChangesRequested = reviews.filter(r => {
      const login = r.user.login.toLowerCase();
      return (login === 'github-actions[bot]' || login.includes('opencode')) && r.state === 'CHANGES_REQUESTED';
    });

    for (const r of botChangesRequested) {
      console.warn(`Dismissing blocking review #${r.id}...`);
      sys.execSync(`gh api -X PUT repos/${repo}/pulls/${prNumber}/reviews/${r.id}/dismissals -f message="Dismissed previous blocking review because the blocking criteria is no longer met."`);
    }
  } catch (error) {
    console.warn(`Warning: Failed to dismiss previous reviews: ${error.message}`);
  }
}

/**
 * Main orchestration entrypoint.
 */
export function main() {
  try {
    const { prNumber, repo } = getEnvConfig();
    const botItems = fetchBotFeedback(repo, prNumber);

    console.warn(`Found ${botItems.length} comments/reviews from the bot.`);
    if (botItems.length === 0) {
      console.warn("No feedback from bot found. Exiting review evaluation.");
      return;
    }

    const results = parseMetadataBlock(botItems) || evaluateFeedbackFallback(botItems);
    console.warn(`Evaluation metrics: Verdict=${results.verdict}, CriticalBugs=${results.criticalBugs}, SecurityIssues=${results.securityIssues}`);

    const { targetState, message } = determineReviewState(results.verdict, results.criticalBugs, results.securityIssues);
    console.warn(`Determined review action: targetState=${targetState}`);

    if (targetState === 'COMMENT' || targetState === 'APPROVE') {
      dismissPreviousChangesRequested(repo, prNumber);
    }

    submitPRReview(prNumber, targetState, message);
    console.warn("Successfully submitted PR review status!");

  } catch (error) {
    console.error("Execution failed:", error.message);
    if (error.stdout) {
      console.error("stdout:", error.stdout.toString());
    }
    if (error.stderr) {
      console.error("stderr:", error.stderr.toString());
    }
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
