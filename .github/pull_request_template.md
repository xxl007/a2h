<!--
Title: conventional commit form, `feat|fix|chore(scope): summary`
  e.g. `feat(mcp): stateless Streamable HTTP endpoint`
One PR per OpenSpec change. Write "How to validate" for the product owner, not for developers.
-->

## Change

- OpenSpec change: `openspec/changes/<change>/` (link it: https://github.com/xxl007/a2h/tree/main/openspec/changes/<change>)
- Issue: closes #<issue>
- Milestone: M<n>

## What this does

<!-- Two or three sentences in product terms. Which spec scenarios does it satisfy? -->

## Preview

<!-- Filled in by the preview workflow's comment on this PR (header "a2h-preview"). Copy the links here once it is green. -->

- Web: <preview web URL>
- MCP endpoint: <preview MCP URL>

## How to validate (product owner)

<!-- Numbered steps a non-developer can follow on the preview: where to click, what to type, what you should see. -->

1.
2.
3.

## Spec scenarios and tests

| Scenario | Test |
|---|---|
| | |

## What was deliberately not done

<!-- Out-of-scope items, follow-ups (with issue links), known limitations. "Nothing" is a valid answer only if true. -->

-

## Checks

- [ ] Every spec scenario of the change has a test
- [ ] CI green (`check`)
- [ ] The one rule: nothing reaches a human that their rules do not allow; nothing leaves a principal that the principal did not approve
- [ ] No PII in logs, no secret in the repo
- [ ] ADR written in `docs/decisions/` if the choice is expensive to reverse
