# Veilo-agent-wallet
Veilo is a privacy-preserving autonomous AI agent wallet on Solana that lets users deploy agents to execute on-chain payments and purchase services within configurable spending limits and revocable permissions.

## Documentation

Product documentation covers owner-created agents, architecture, private funding,
spending policy, security boundaries and verification requirements.

- [Overview](docs/index.md)
- [Architecture](docs/guide/architecture.md)
- [Security model](docs/security/assessment.md)
- [AI context](docs/ai-context.md)

Run locally with Node.js 22 or later:

```sh
cd docs
npm ci
npm run dev
```

Use `npm run build` and `npm run preview` from `docs/` to check the static site.
The default Pages base path is `/Veilo-agent-wallet/`; set `DOCS_BASE=/` for a custom domain.
GitHub Pages deployment runs from `main` after Pages is configured to use GitHub Actions.
