# I-m-Genius

[中文](README.md) · [Privacy and data boundaries](PRIVACY.md) · [MIT License](LICENSE)

Collect development progress from Codex and Claude Code in one Markdown journal. Keep a daily record without publishing your working projects' code.

**Windows preview.** Native hooks receive events, the AI working on the task chooses a fixed category and status, and a local worker appends to `WORKLOG.md` and creates real Git commits. Upload is optional: enable one HTTPS journal repository and, optionally, one mirror.

| 时间（UTC） | 类别 | 状态 | 进度 |
| --- | --- | --- | --- |
| 2026-10-12 08:15:30 | 实现 | 进行中 | 1 commit! smart! |
| 2026-10-12 08:26:12 | 验证 | AI报告完成 | 2 commit! smart! |

The current journal headings and category/status labels are Chinese. `N commit!` counts **new state rows on that UTC date**, not Git commits. Several rows processed in one batch can share a real Git commit. The count does not measure code quality or hours worked. “AI报告完成” means the AI reports completion.

## Requirements

- Windows x64, Node.js with npm, and Git for Windows. The development environment uses Node.js **22.14.0** and Git **2.49.0.windows.1**; other environments have not been fully qualified.
- Git at `C:/Program Files/Git/cmd/git.exe`. This preview does not choose an arbitrary Git executable from PATH.
- Codex and/or Claude Code installed, authenticated and working. Supported entry discovery is described [below](#support-and-limitations).
- Automatic background startup uses the Windows .NET Framework compiler at `%SystemRoot%/Microsoft.NET/Framework64/v4.0.30319/csc.exe`. It builds a small launcher locally, without downloading a launcher. Use manual mode if the compiler is unavailable.
- A **new, separate, empty journal repository** on GitHub, Gitee, GitLab or another HTTPS Git host. Do not initialize a README, license or `.gitignore`. A private repository is supported. An optional mirror must also be empty and have a different URL.

**`cdzdd/I-m-Genius` is the project's source repository. Do not use it, or your work project's repository, as the journal destination.** This preview supports a new empty journal, one writing computer, and the fixed `main` branch. It does not import existing project or journal history.

Use an HTTPS destination such as `https://github.com/YOUR_NAME/my-ai-data.git`. Upload uses normal Git credential management. Ensure ordinary Git authentication works for your repository. Do not put passwords or tokens in URLs, commands or chat messages.

## 1. Clone and build

Run in a regular PowerShell session; administrator privileges are not required:

```powershell
New-Item -ItemType Directory -Path C:/AI -Force | Out-Null
git clone https://github.com/cdzdd/I-m-Genius.git C:/AI/I-m-Genius
Set-Location C:/AI/I-m-Genius
npm ci
npm run build
```

Installation is from the source checkout; no npm install package is published. `npm ci` downloads the locked dependencies. After installation, keep the source directory, Node executable and private data directory in place: client hooks and the startup task store absolute paths.

## 2. Initialize and connect the clients

Replace the destination, Git name and email. The email becomes Git history metadata. If you want a noreply address, copy the complete address displayed in your hosting account's email settings.

```powershell
$config = 'C:/AI/I-m-Genius-data/config.json'
node .\dist\src\cli.js init --config $config --repo https://github.com/YOUR_NAME/my-ai-data.git --name 'YOUR_NAME' --email 'YOUR_GIT_EMAIL' --source codex --source claude
```

Remove one `--source` if you only use one client. Initialization merges three owned hooks and registers a stdio MCP server named `whativedone`, preserving existing client configuration and keeping original configuration backups in the private data directory. It does not change accounts, select a model or grant client trust for you.

The private directory must be absent or empty and separate from the source checkout. Successful initialization prints `configPath`. Set `$config` to that **exact printed path** for all later commands: Windows packaged-app filesystem redirection can change the physical location. Do not rerun `init` on an existing installation.

The initial mode is `local`: this project's journal Git network operations are disabled. By default, initialization installs a current-user logon task and starts the worker immediately without a terminal window. It processes a batch approximately every 60 seconds, runs without elevation, and requires a logged-in user.

For manual processing, append `--no-startup` to `init`, then keep this command running while you want the journal updated:

```powershell
node .\dist\src\cli.js sync --watch --config $config
```

Closing this manual window stops processing. Events captured by the hooks remain queued locally.

## 3. Test locally

Restart Codex, reload the editor window using Claude Code, or reopen Claude Code CLI to reconnect the MCP server. Grant MCP/workspace trust and hook permission through the clients' normal flows. Codex native hook trust requires confirmation in Codex; installation does not bypass it.

Complete a small task with meaningful progress in a new chat. The AI should call `mcp__whativedone__classify_progress` with only category and status. Wait about a minute, then inspect:

```powershell
node .\dist\src\cli.js status --config $config
node .\dist\src\cli.js preview --config $config
```

The journal is `repository/WORKLOG.md` under the printed configuration directory. It may not exist until the first valid classification. `preview` shows pending local Git commits, full journal content, patches and Git identity. It does not contact the network or drain the queue. In manual mode, run `sync --config $config` once first if needed.

Recording depends on the AI making the classification tool call; a record for every chat is not guaranteed. Repeated identical category/status values within a turn do not append another row. `none/unknown` stays local. There is no transcript scan or assumption that a stopped task is completed.

## 4. Review and enable upload

Review preview and your Git email, then run:

```powershell
node .\dist\src\cli.js enable-sync --config $config
```

To upload to a second host, use this **instead, during first enablement**:

```powershell
node .\dist\src\cli.js enable-sync --config $config --mirror https://gitee.com/YOUR_NAME/my-ai-data.git
```

`init` also accepts `--mirror` while remaining local. Choose both destinations before first enablement: adding a new mirror after the primary contains journal history is not supported.

`enable-sync` displays the targets, branch and Git identity, checks every destination is empty, and saves authorization for future rule-based batches. It does not ask for approval per row. Both hosts receive the same audited history. Authentication or network failure at one destination is retried independently and does not block local recording or the healthy destination. Unknown remote history or manual journal changes block publication instead of forcing an overwrite. No force push is used.

The source checkout and journal repository are separate. Work project files, raw conversations and client configuration backups are excluded from the journal repository. **A push also transmits Git author/committer names, email addresses, times, fixed commit messages and Git object metadata.** Read [PRIVACY.md](PRIVACY.md) for the exact boundaries.

## Daily labels

Times use UTC in `YYYY-MM-DD HH:MM:SS` format. Categories are research / planning / implementation / verification / debugging; statuses are in progress / waiting for input / blocked / AI-reported done. The Chinese labels are shown in the journal.

Each UTC date starts at one. The label advances after each group of 20 rows. Counts continue without a cap; the last label stays the same:

| Daily state rows | Label |
| --- | --- |
| 1–20 | smart! |
| 21–40 | clever! |
| 41–60 | intelligent! |
| 61–80 | brilliant! |
| 81–100 | genius! |
| 101–120 | true genius! |
| 121–140 | super genius! |
| 141+ | absolute incredible genius! |

## Manage, upgrade and uninstall

Run these from the source directory, using the exact saved `$config` path:

```powershell
node .\dist\src\cli.js status --config $config
node .\dist\src\cli.js pause --config $config
node .\dist\src\cli.js resume --config $config
node .\dist\src\cli.js start --config $config
node .\dist\src\cli.js uninstall --config $config
```

- `pause` stops new capture and publication; an in-flight batch can finish. `resume` restores capture and requests revalidation of errors, without repairing invalid history.
- `start` runs the already installed background task. An active worker is not duplicated. For manual mode, use `sync --watch`.
- `uninstall` disables capture and removes matching owned hooks, MCP registration and the logon task. It **retains journal history, configuration and backups**. Modified third-party registrations are not blindly removed. Keep `CODEX_HOME` / `CLAUDE_CONFIG_DIR` unchanged until uninstall finishes.

For an upgrade, pause first. Keep all installation paths unchanged and update the source/build:

```powershell
node .\dist\src\cli.js pause --config $config
git pull --ff-only
npm ci
npm run build
```

Then sign out of Windows and sign back in, or restart Windows, so the old worker and MCP processes exit. The logon task loads the new build while capture remains paused. Reopen PowerShell in `C:/AI/I-m-Genius`, set `$config` to the saved physical path again, and run:

```powershell
node .\dist\src\cli.js resume --config $config
node .\dist\src\cli.js start --config $config
```

Reconnect/reload the AI clients afterward. Do not initialize again or manually edit journal content, Git history or upload destinations. Valid older display formats upgrade deterministically on subsequent progress, retaining original times/categories/statuses and historical commits.

## Support and limitations

This preview is Windows-only. Compatibility development uses Codex CLI **0.162.0** and Claude Code **2.1.295**. The author has observed recording in Codex desktop and real GitHub/Gitee dual-destination synchronization on their computer. This does not qualify every client version, installation layout or editor entry.

- Codex registration first recognizes `%LOCALAPPDATA%/Programs/OpenAI/Codex/bin/codex.exe`, otherwise the exact `bin/codex.js` entry in `%APPDATA%/npm/node_modules/@openai/codex`. Other standalone installer layouts or custom npm prefixes are unsupported. Configuration uses `CODEX_HOME`, or `~/.codex`, merging `hooks.json` and `config.toml`.
- Claude registration recognizes exact `cli.js` or `bin/claude.exe` entries in `%APPDATA%/npm/node_modules/@anthropic-ai/claude-code`. Configuration uses `CLAUDE_CONFIG_DIR`, or `~/.claude/settings.json` and `~/.claude.json`; a custom directory uses its `.claude.json`.
- Editor extensions require shared supported configuration and the expected native event/MCP fields. Claude Code VS Code still requires a local user test. Codex IDE, other AI tools, macOS/Linux, other Claude installation layouts, and Cowork/staging profiles are outside this preview's supported scope.
- Missing native session/turn IDs, failed results and unknown result wrappers fail closed. There is no transcript fallback. Integration status `configured_unverified` means configuration was installed and a local client test is required.
- There is no chat lookup, work project backup, free-text summary, or automatic backfill of missed chats. Contribution graph display depends on the Git host's own rules.

## Troubleshooting and audit

Check `captureEnabled`, `queuedCount`, `unclassifiedCount`, `errorCode` and per-target status in `status`. A queue that is not being processed suggests checking the background task, running `start`, or a one-shot `sync`. An empty queue with increasing unclassified turns suggests checking MCP availability, hook permission and classification tool calls in the client.

Do not publish raw chats, original configuration backups, secrets or tokens when reporting an issue. Client entry/version, fixed error codes, whether the classification tool appeared, and whether WORKLOG exists are enough to start diagnosis.

Production logic is kept in seven readable modules. All project subprocess execution is in [`src/transport.ts`](src/transport.ts):

| Module | Responsibility |
| --- | --- |
| `schema.ts` | Fixed fields, journal formatting and content validation |
| `mcp.ts` | Category/status classification tool |
| `capture.ts` | Native event projection and hook output |
| `store.ts` | Private queue, state and locks |
| `transport.ts` | Git, credential settings, client registration, ACL and startup |
| `publish.ts` | Local transactions, history audit and independent retries |
| `cli.ts` | Initialization and management commands |

The fixed GUI launcher's C# source is embedded in `transport.ts` and saved locally as `startup-launcher.cs` when compiled. Review it alongside the TypeScript: it only starts Node without a console, waits and returns the exit code.

Contributors can run `npm ci` and `npm test` from a source checkout. Tests cover fixed classifications, native JSON contracts, privacy boundaries, real local Git, dual-target failure recovery and startup definitions. Test doubles do not establish compatibility with every real client or hosting service.
