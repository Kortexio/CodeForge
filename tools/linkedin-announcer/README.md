# LinkedInAnnouncer

.NET 9 console tool that posts CodeForge release announcements to LinkedIn.

## Modes

```bash
# One-shot OAuth (local)
export LINKEDIN_CLIENT_ID=...
export LINKEDIN_CLIENT_SECRET=...
dotnet run --project tools/linkedin-announcer -- get-token

# CI / local post
export DRY_RUN=true
export RELEASE_TAG=v0.1.3
export RELEASE_BODY="- feat: ..."
export REPO_URL=https://github.com/Kortexio/CodeForge
# + LINKEDIN_* secrets
dotnet run --project tools/linkedin-announcer -- post
```

Post format: short hook + what's new + repo / download / notes CTA. Optional `LINKEDIN_ORG_URN` posts as the company page.

Put `[skip-announce]` in the GitHub Release notes body to publish a release without posting to LinkedIn.
