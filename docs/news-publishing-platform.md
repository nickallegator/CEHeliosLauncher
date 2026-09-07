# Allegator Games News publishing

Allegator Games News is authored in the private `nickallegator/AllegatorGamesNews` repository and published as a static Cloudflare Pages site at `https://news.allegatorgames.com`.

The canonical Markdown source generates all public representations in one build:

- `/api/v1/news.json` for current AG Launcher versions.
- `/rss.xml` for older launchers and external readers.
- `/news/<slug>/` and `/` for the public archive.

## Runtime discovery

Set these values on the release API service:

```text
NEWS_ENABLED=true
NEWS_PUBLIC_BASE_URL=https://news.allegatorgames.com
NEWS_REFRESH_SECONDS=900
```

The release API replaces the obsolete template RSS address when it issues an authorized distribution. It also injects schema-versioned JSON discovery. No release-bucket credentials are shared with the News site.

## Standalone publishing

Clone the News repository and run `publish-news.cmd`. The wizard validates the worktree, creates the article, runs tests and a deterministic build, opens a local preview, and creates a review pull request only after explicit confirmation. Short posts can also be drafted through the repository's **Create standalone News draft** workflow.

Merging a reviewed pull request to `main` is the publication boundary. Cloudflare Pages deploys only validated `main` content. Revert the content commit or restore the prior Pages deployment to withdraw a bad publication.

## Release drafts

Launcher publication and Cobble Power test-channel promotion request idempotent News drafts through the `Allegator Games News Dispatcher` GitHub App. Configure these launcher-repository secrets:

```text
AG_NEWS_DISPATCH_APP_ID
AG_NEWS_DISPATCH_PRIVATE_KEY
```

Install the App only on `AllegatorGamesNews` with `Contents: write` and mandatory metadata access. News dispatch is deliberately non-critical: failures appear as workflow warnings but never invalidate a verified binary or promoted mod release. Use the News repository's **Create release News draft** workflow to recover an existing release.
