# Third-party notices

I-m-Genius / whativedone is distributed under the [MIT License](LICENSE).

The test schema fixtures in `test/fixtures/codex-0.162.0/` were generated from
OpenAI Codex 0.162.0 and are covered by its Apache License 2.0. Their original
license and notice are retained in [licenses/codex](licenses/codex).

Source installations obtain runtime dependencies through `npm ci`. The Windows
x64 ZIP bundles locked production dependencies in `payload/app/node_modules`;
each dependency retains its own license with the installed package:

| Dependency | Locked version | License |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | 1.32.1 | MIT |
| `proper-lockfile` | 4.1.2 | MIT |
| `smol-toml` | 1.9.0 | BSD-3-Clause |

Transitive and development dependencies have their own licenses. See the
exact versions and integrity hashes in `package-lock.json` and the licenses
installed with those packages. The npm `.tgz` does not bundle dependencies;
the prebuilt Windows ZIP does.

The Windows ZIP also bundles the official Node.js **22.23.3** Windows x64
runtime as `payload/node.exe`. Node.js and its bundled third-party components have
their own licenses and notices, retained in **`payload/node-LICENSE`** in the
ZIP and installed program directory. The packaging process verifies the official
Node archive against a pinned SHA-256 hash. The install manifest is an integrity
check, not a cryptographic release signature.
