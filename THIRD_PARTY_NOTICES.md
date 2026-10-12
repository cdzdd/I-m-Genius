# Third-party notices

I-m-Genius / whativedone is distributed under the [MIT License](LICENSE).

The test schema fixtures in `test/fixtures/codex-0.162.0/` were generated from
OpenAI Codex 0.162.0 and are covered by its Apache License 2.0. Their original
license and notice are retained in [licenses/codex](licenses/codex).

Runtime dependencies are installed separately by `npm ci`; each dependency
retains its own license in `node_modules`:

| Dependency | Locked version | License |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | 1.32.1 | MIT |
| `proper-lockfile` | 4.1.2 | MIT |
| `smol-toml` | 1.9.0 | BSD-3-Clause |

Transitive and development dependencies have their own licenses. See the
exact versions and integrity hashes in `package-lock.json` and the licenses
installed with those packages. The release archive does not bundle dependencies.
