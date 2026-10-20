# datran

Self-hosted file sharing on a self-optimizing, evolutionary compression network:

- **Emergent speed:** compression recipes evolve per content type on real uploads and are shared across nodes.
- **Data gravity:** files replicate toward the nodes where they're requested, and cold copies are dropped only when they're safely replicated elsewhere.
- **Self-rewriting storage:** deduplicated chunks are fused into super-chunks when that measurably helps.
- **Generative compression:** data produced by a simple rule (fills, repeating blocks, counters) is stored as that rule, losslessly. One test reached 61,511×.
- **Prediction:** likely downloads are prepared in advance.
- **Polyglot API:** an OpenAPI spec with clients for Python, Rust, C++ and TypeScript.

Every byte is stored losslessly and verified.

Around that core:
- **Encryption:** end-to-end-encrypted links, plus encryption at rest on every storage node.
- **Uploads:** resumable, so dropped connections and page reloads pick up where they stopped.
- **Accounts:** Free and Pro plans with Stripe billing, and a mobile app.
- **Deployment:** an HTTP/3 deployment, metrics, and backups that are verified on restore.

```bash
npm install && (cd diocom-app && npm install)
cp diocom-app/.env.example diocom-app/.env.local   # set DIOCOM_SECRET at minimum
npm start                                           # reactor :3005 + web app :3001
```

See [DOCUMENTATION.md](DOCUMENTATION.md) for the architecture, measured benchmarks and configuration.
