import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getEnvConfig,
  fetchPrDiff,
  fetchDeepSeekReview,
  postPrComment,
  main,
  sys
} from './run-deepseek-review.js';
import fs from 'fs';

const originalEnv = process.env;

describe('getEnvConfig', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      DEEPSEEK_API_KEY: 'ds-key',
      GITHUB_TOKEN: 'gh-token',
      PR_NUMBER: '42',
      GITHUB_REPOSITORY: 'owner/repo'
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return all env vars when present', () => {
    const result = getEnvConfig();
    expect(result).toEqual({
      deepseekApiKey: 'ds-key',
      githubToken: 'gh-token',
      prNumber: '42',
      repoFullName: 'owner/repo'
    });
  });

  it('should throw when a required env var is missing', () => {
    delete process.env.DEEPSEEK_API_KEY;
    expect(() => getEnvConfig()).toThrow('Missing required environment variables');
  });
});

describe('fetchPrDiff', () => {
  let fetchSpy;

  beforeEach(() => {
    vi.restoreAllMocks();
    fetchSpy = vi.spyOn(sys, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => 'diff --git a/file.ts b/file.ts'
    });
  });

  it('should fetch the PR diff with the correct headers', async () => {
    const diff = await fetchPrDiff('owner/repo', '42', 'gh-token');
    expect(diff).toBe('diff --git a/file.ts b/file.ts');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/pulls/42',
      {
        headers: {
          Authorization: 'Bearer gh-token',
          'X-GitHub-Api-Version': '2022-11-28',
          Accept: 'application/vnd.github.v3.diff'
        }
      }
    );
  });

  it('should throw when GitHub API returns an error', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => 'not found'
    });

    await expect(fetchPrDiff('owner/repo', '42', 'gh-token')).rejects.toThrow(
      'Failed to fetch PR diff: 404 Not Found'
    );
  });
});

describe('fetchDeepSeekReview', () => {
  let fetchSpy;

  beforeEach(() => {
    vi.restoreAllMocks();
    fetchSpy = vi.spyOn(sys, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        choices: [
          { message: { content: 'Great code!\n[OPENCODE_VERDICT_METADATA]\nVerdict: POSITIVE\nCriticalBugs: 0\nSecurityIssues: 0' } }
        ]
      })
    });
  });

  it('should call DeepSeek API with correct payload and return review text', async () => {
    const review = await fetchDeepSeekReview('some diff', 'ds-key');
    expect(review).toContain('Great code!');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.deepseek.com/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ds-key'
        }
      })
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.model).toBe('deepseek-v4-flash');
    expect(body.temperature).toBe(0.1);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1].content).toContain('some diff');
  });

  it('should throw on DeepSeek API error', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'invalid key'
    });

    await expect(fetchDeepSeekReview('diff', 'bad-key')).rejects.toThrow(
      'DeepSeek API error: 401'
    );
  });

  it('should throw on empty or malformed response', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ choices: [] })
    });

    await expect(fetchDeepSeekReview('diff', 'key')).rejects.toThrow(
      'DeepSeek API returned an empty or unexpected response'
    );
  });
});

describe('postPrComment', () => {
  let fetchSpy;

  beforeEach(() => {
    vi.restoreAllMocks();
    fetchSpy = vi.spyOn(sys, 'fetch').mockResolvedValue({
      ok: true,
      status: 201,
      statusText: 'Created'
    });
  });

  it('should post a comment to the PR with correct headers', async () => {
    await postPrComment('owner/repo', '42', 'gh-token', 'LGTM');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/issues/42/comments',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer gh-token',
          'X-GitHub-Api-Version': '2022-11-28',
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ body: 'LGTM' })
      }
    );
  });

  it('should throw when GitHub API returns an error', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden'
    });

    await expect(postPrComment('owner/repo', '42', 'token', 'body')).rejects.toThrow(
      'Failed to post PR comment: 403 Forbidden'
    );
  });
});

describe('main integration', () => {
  const originalEnv = process.env;
  let fetchSpy;
  let writeFileSyncSpy;
  let exitSpy;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = {
      ...originalEnv,
      DEEPSEEK_API_KEY: 'ds-key',
      GITHUB_TOKEN: 'gh-token',
      PR_NUMBER: '5',
      GITHUB_REPOSITORY: 'owner/repo'
    };

    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});

    fetchSpy = vi.spyOn(sys, 'fetch').mockImplementation((url) => {
      if (url.includes('github.com/repos') && !url.includes('/issues/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => 'diff --git a/src/index.ts b/src/index.ts'
        });
      }
      if (url.includes('/chat/completions')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: 'Review text here' } }]
          })
        });
      }
      if (url.includes('/issues/')) {
        return Promise.resolve({
          ok: true,
          status: 201
        });
      }
      return Promise.resolve({ ok: true });
    });

    writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should run the full review pipeline', async () => {
    await main();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(writeFileSyncSpy).toHaveBeenCalledWith('review-result.txt', 'Review text here', 'utf-8');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('should call process.exit(1) on pipeline failure', async () => {
    fetchSpy.mockReset().mockRejectedValue(new Error('Network failure'));
    await main();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
