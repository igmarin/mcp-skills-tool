import fs from 'fs';
import { fileURLToPath } from 'url';

/**
 * Injectable fetch wrapper for testability.
 * In production, this is the global `fetch` function.
 */
export const sys = {
  fetch: (url, init) => fetch(url, init)
};

/**
 * Validates that all required environment variables are present.
 * @returns {{ deepseekApiKey: string, githubToken: string, prNumber: string, repoFullName: string }}
 * @throws If any required environment variable is missing
 */
export function getEnvConfig() {
  const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
  const githubToken = process.env.GITHUB_TOKEN;
  const prNumber = process.env.PR_NUMBER;
  const repoFullName = process.env.GITHUB_REPOSITORY;

  if (!deepseekApiKey || !githubToken || !prNumber || !repoFullName) {
    throw new Error(
      'Missing required environment variables: DEEPSEEK_API_KEY, GITHUB_TOKEN, PR_NUMBER, GITHUB_REPOSITORY'
    );
  }

  return { deepseekApiKey, githubToken, prNumber, repoFullName };
}

/**
 * Fetches the raw Git diff for a pull request from the GitHub API.
 *
 * @param {string} repoFullName - Repository in "owner/repo" format
 * @param {string} prNumber - Pull request number
 * @param {string} githubToken - GitHub API token
 * @returns {Promise<string>} The raw diff text
 * @throws If the GitHub API request fails
 */
export async function fetchPrDiff(repoFullName, prNumber, githubToken) {
  const response = await sys.fetch(
    `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`,
    {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
        Accept: 'application/vnd.github.v3.diff'
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch PR diff: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

/**
 * Sends a code diff to the DeepSeek API and returns the generated review.
 *
 * @param {string} diff - The Git diff to review
 * @param {string} apiKey - DeepSeek API key
 * @returns {Promise<string>} The review text from DeepSeek
 * @throws If the DeepSeek API request fails
 */
export async function fetchDeepSeekReview(diff, apiKey) {
  const systemPrompt = `You are a Principal TypeScript/Node.js Architect reviewing a Pull Request for "mcp-skills-tool", a Model Context Protocol (MCP) server built with TypeScript and Node.js.

Analyze the code diff carefully and provide feedback strictly based on these priorities:

1. TYPE SAFETY, ERROR HANDLING & ZOD VALIDATION (Highest Priority):
   - Ensure all JSON inputs and external data are strictly validated using Zod schemas.
   - Verify that error handling is robust, with meaningful error messages propagated to MCP clients.
   - Check for proper use of TypeScript strict mode; avoid implicit \`any\`, unhandled promises, or missing type guards.

2. MCP PROTOCOL COMPLIANCE & ARCHITECTURE:
   - Ensure MCP server initialization follows SDK best practices (capabilities, request handlers, resource/tool schemas).
   - Verify that resource URIs (\`skill://\`) and tool inputs are correctly formatted and validated.
   - Check for clean separation between transport layer (stdio/SSE), server logic, and configuration parsing.

3. TEST ROBUSTNESS, HYGIENE & COVERAGE:
   - Verify that unit tests (Vitest) cover critical paths: Zod parsing, MCP handler behavior, error cases.
   - Ensure tests mock external dependencies cleanly and do not leak state between test cases.
   - Check that coverage thresholds (70%) are not regressing.

4. SECURITY & DEPLOYMENT:
   - Check for injection risks in file paths or remote URLs (path traversal, SSRF).
   - Verify Docker build is minimal and secure (no unnecessary privileges, minimal base image).
   - Ensure no secrets or API keys are hardcoded in source files.

CRITICAL INSTRUCTIONS:
- Focus comments on [Critical Bug], [Architectural Flaw], or [Optimization].
- Do NOT comment on minor formatting or styling unless it causes runtime degradation or security issues.
- In your summary review comment, you MUST include a metadata block at the very end in the following exact format (no formatting or code blocks around it):
  [OPENCODE_VERDICT_METADATA]
  Verdict: <NEGATIVE | NEUTRAL | POSITIVE>
  CriticalBugs: <count of critical bugs found>
  SecurityIssues: <count of security issues found>`;

  const response = await sys.fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Review the following Git diff:\n\n${diff}` }
      ],
      temperature: 0.1
    })
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`DeepSeek API error: ${response.status} - ${errBody}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('DeepSeek API returned an empty or unexpected response');
  }

  return content;
}

/**
 * Posts a review comment to the pull request via the GitHub Issues API.
 *
 * @param {string} repoFullName - Repository in "owner/repo" format
 * @param {string} prNumber - Pull request number
 * @param {string} githubToken - GitHub API token
 * @param {string} body - Comment body text
 * @returns {Promise<void>}
 * @throws If the GitHub API request fails
 */
export async function postPrComment(repoFullName, prNumber, githubToken, body) {
  const response = await sys.fetch(
    `https://api.github.com/repos/${repoFullName}/issues/${prNumber}/comments`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${githubToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ body })
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to post PR comment: ${response.status} ${response.statusText}`);
  }
}

/**
 * Orchestrates the full review pipeline:
 * fetch diff → DeepSeek review → post comment → write result file.
 *
 * @returns {Promise<void>}
 */
export async function main() {
  try {
    const { deepseekApiKey, githubToken, prNumber, repoFullName } = getEnvConfig();

    console.warn(`Fetching diff for PR #${prNumber} in ${repoFullName}...`);
    const diff = await fetchPrDiff(repoFullName, prNumber, githubToken);

    if (!diff.trim()) {
      console.warn('Diff is empty. Skipping review.');
      return;
    }

    console.warn('Sending diff to DeepSeek (deepseek-v4-flash)...');
    const review = await fetchDeepSeekReview(diff, deepseekApiKey);

    console.warn('Posting review comment to PR...');
    await postPrComment(repoFullName, prNumber, githubToken, review);

    fs.writeFileSync('review-result.txt', review, 'utf-8');
    console.warn('Review completed successfully.');
  } catch (error) {
    console.error('Review failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
