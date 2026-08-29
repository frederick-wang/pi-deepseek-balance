# CLAUDE.md

@AGENTS.md

Project standards, implementation notes, and conventions live in `AGENTS.md` (imported above). Summary:

- No credentials, keys, or personal data anywhere in the repo (config, tests, docs, examples). API keys come from env/`auth.json` at runtime only.
- English shipped text with an idiomatic Chinese README mirror; zero runtime deps; single extension file.
- Currency handling is a correctness boundary (row selection, no cross-currency math, rate in one currency); no gauge without a real denominator.
- Before any release: tarball smoke under real pi.
- npm publishing follows the AGENTS.md notes (404-vs-auth, OIDC setup-node shape, git+ repository url).
