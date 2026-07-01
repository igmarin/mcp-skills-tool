# Code Review

Review a diff for correctness, clarity, and style before it is merged. Keep
feedback specific and actionable, and call out what is good as well as what
needs changing.

## When to use

- A pull request or patch needs a focused review.
- You want a second pass over your own change before opening a PR.

## Checklist

1. **Correctness** — does the change do what it claims? Look for off-by-one
   errors, unhandled edge cases, and broken assumptions.
2. **Tests** — are new code paths covered? Do existing tests still make sense?
3. **Clarity** — are names, comments, and structure easy to follow?
4. **Style** — does the change match the surrounding conventions and linting
   rules?
5. **Security** — is external input validated? Are secrets kept out of the code?

## Output

Summarize the review as a short verdict (approve / comment / request changes)
followed by a bulleted list of concrete findings, each tied to a file and line.
