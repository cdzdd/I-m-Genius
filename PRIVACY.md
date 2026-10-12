# 隐私与数据边界 / Privacy and data boundaries

[中文使用指引](README.md) · [English guide](README.en.md)

I-m-Genius 限制保留与上传的数据，便于使用者审查。它不提供操作系统沙箱，也不承诺绝对保密。AI 客户端、插件、Git、凭据管理器、Windows 和其他进程有各自的访问权限与联网行为。

## 数据如何经过本项目

| 数据 | 接收／使用 | 本地保存 | 日志上传 |
| --- | --- | --- | --- |
| 对话正文、工具输出、工作路径、对话文件路径及未知钩子字段 | 原生钩子的标准输入可能含有这些字段；输入上限 1 MiB | 捕获阶段丢弃，不写入队列或错误文本；不打开对话文件 | 不加入日志仓库 |
| 原生会话／轮次／工具调用 ID | 使用本机随机密钥计算 HMAC | 仅保存 HMAC 事件与轮次标识，防重放并关联分类；不保存原始 ID | 不上传 |
| 工具来源、事件类型、记录时间 | 固定字段 | 队列、状态及事务；内部时间为 ISO UTC 毫秒格式 | 仅允许时间进入日志，显示为 `YYYY-MM-DD HH:MM:SS` UTC |
| 类别／状态 | 精确白名单；工具输入须匹配成功返回值 | 固定分类；`none/unknown` 留在本地 | 五种类别、四种状态，不含自由文本 |
| 每日状态数及称号 | 从 UTC 日期的日志行数计算 | `WORKLOG.md`，无独立计数存储 | `N commit!` 与八个固定称号之一，按每 20 行校验 |
| Git 姓名、邮箱、时间、提交信息、对象及父子关系 | 指定身份和真实本地 Git 历史 | Git 对象、配置、预览和回执 | 作为真实 Git 推送的一部分上传 |
| 目标 URL／分支、待上传对象、凭据助手名称及操作结果／时间 | 发送检查 | 配置、清单、回执和状态 | Git 主机与认证服务会看到相关协议数据 |
| 原 AI 客户端配置 | 仅在指定集成、合并与卸载所有权检查时读取 | 原始备份位于私有数据目录，可能含敏感配置 | 不加入日志仓库 |
| Git 凭据 | 正常 Git／凭据助手处理 | 本项目不存储或读取凭据正文；助手可能有独立存储 | Git 登录／认证可能联系额外服务 |

严格模式关闭自由文本摘要：当前工具只接受 `category` 和 `status`，没有项目名、任务正文、对话标题或摘要字段。成功返回必须与输入匹配；未知包装、多余文本、错误返回或缺少原生 ID 会拒绝记录。仅允许预定义类别和状态不意味着 AI 的判断一定正确；`AI报告完成` 不是独立验证结果。

原生钩子仍会把完整输入交给本项目进程。准确的承诺是“不保留、不上传原始对话”，而不是“进程从未接触过对话”。本项目不扫描历史对话、不打开会话记录文件、不通过回读正文补写漏记。

## 本地目录和安装

默认私有目录为 `%LOCALAPPDATA%/WhatIveDone`，或显式 `--config` 的父目录。初始化要求专用目录不存在或为空，并在写入前设置当前用户的 Windows ACL。配置、HMAC 密钥、队列／状态／事务、原始配置备份、回执和日志 Git 仓库保存在这里。

这些权限降低意外访问，但不限制管理员、恶意软件、拥有用户权限的进程、备份系统或 AI 客户端。请保护此目录；原配置备份可能保留你已有的敏感设置。卸载保留这些文件和日志历史，供你检查与自行决定保留期限，不自动删除。

源码安装的 `npm ci` 会下载第三方依赖。申请集成时，程序调用已安装客户端的 MCP 管理入口，并合并自己的钩子。客户端的登录、模型请求、插件与更新可能有独立联网行为，不能用本项目的本地模式限制这些行为。

## 能清楚审查的联网部分

所有项目子进程执行集中在 [`src/transport.ts`](src/transport.ts)，包括本地 Git、凭据助手配置检查、客户端 MCP 注册、ACL 和后台任务。Git 网络操作只使用固定参数和已配置的 HTTPS 日志目标；隔离 Git 钩子、属性与非允许的配置，只恢复白名单中的标准凭据助手。

- `local` 模式不执行本项目的日志 Git 网络命令；`preview` 也不联网。
- `enable-sync` 联网检查空目标，并明确保存对未来批次的授权，不是逐条人工批准。
- 自动模式约每 60 秒处理一次。目标已经确认拥有当前提交时，跳过不必要的远端查询。
- Git 凭据助手可能联系日志主机以外的身份／登录服务。普通客户端 MCP 管理命令也可能触发客户端自己的联网行为。
- 暂停停止新捕获和发送，但不取消已经开始的操作。网络失败保留待发送历史以重试。

一份本地日志可上传至主 HTTPS 目标和一个明确授权的镜像，二者收到相同的审核后提交，分别保存进度与回执。一处失败不改变目的地，也不阻止本地记录或另一处。仅编辑配置或运行 `resume` 不会授权新的镜像。

程序不使用 Git 的全引用 `--mirror` 推送、不发送其他分支或标签、不递归发送子模块、不强制覆盖远端。正常业务内容只允许 `WORKLOG.md`，但 **Git 元数据、网络协议与认证流量也会传输**；“只有 Markdown 文件的字节离开电脑”是不准确的。真实邮箱会暴露给每个目标及拥有其历史访问权的人；公开日志仓库会向公众公开该邮箱。

## 上传内容与历史检查

`preview` 从本地 Git 历史生成快照，先审核全部由本项目管理的根历史，再显示已知上传基线后的提交。每个提交包括对象 ID、父提交、作者／提交者姓名与邮箱和时间、固定提交信息、文件列表、完整日志与修改内容。它不是网络字节抓包；基线只代表最近一次保存的远端检查。

审核检查每个中间提交，不能先加入敏感内容再回退以隐藏违规历史。只有普通追加，以及旧三列表／方框进度条向固定称号的确定性显示转换可以通过；原有时间／类别／状态保留。禁止其他改写、删除、降级、混用样式以及错误的每日计数／称号。AI 无法提交自由文本进度。

拒绝时返回固定错误，不输出违规补丁。如果有人手动将敏感文字提交进本地仓库，这些文字已存在于本地 Git 对象；本项目阻止预览／发送，不会自动清除这些对象。因此不要手动编辑日志或复用工作项目仓库。

本地 `receipt.json`、`send-manifest.json` 和镜像对应文件记录操作目标、提交、时间、结果和凭据助手披露，不作为日志文件上传。它们记录的是观察到的 Git 结果，并非托管平台独立签发的密码学回执。发送成功但回执丢失时，后续会先检查远端再重试。

## 后台启动与审查范围

默认启动任务仅在当前用户登录后运行，使用普通权限。小型 GUI 启动器只负责启动已配置的 Node／CLI／配置文件命令，不显示控制台，等待子进程退出并返回退出码。固定 C# 源码嵌于 `transport.ts`，保存在私有目录的 `startup-launcher.cs`，由系统 .NET Framework 编译器本地编译成 `startup-launcher.exe`；无启动器下载与上传。这两个文件位于日志仓库之外。

生产源码有七个模块。AST／导入边界测试检查本项目源码与入口，禁止项目 HTTP／socket 导入、fetch／WebSocket、动态执行以及 `transport.ts` 之外的子进程入口；还使用私有文字 canary 测试捕获、Git、预览与回执。类型导入不执行运行时代码。

这些测试不审查依赖内部、不证明外部程序或操作系统的行为，不是完整的数据流证明，也不独立审查编译后启动器。MCP SDK 处理协议外壳；本项目校验固定分类、原生结果形状和安全投影。合成测试不保证每个客户端／编辑器版本都提供同样的事件。请按 README 完成本机试用，并查看实际上传预览。

## English summary

I-m-Genius minimizes persisted and uploaded data. It is not an OS sandbox or a promise of absolute secrecy; clients, plugins, Git, credential helpers and Windows retain their own behavior.

Native hook stdin can include raw conversation text, tool output and paths. The input is capped at 1 MiB; capture discards these fields and never opens transcripts. Raw native IDs are converted to local HMAC event/turn keys. Only fixed event fields and exact category/status values enter the private queue; `none/unknown` is not published. Classification depends on the AI making the call and reporting correctly.

The journal contains UTC time, one of five categories, one of four statuses, and a count-derived daily badge. It has no free-text summary, project name or chat title. **Real Git pushes also transmit author/committer names, emails, times, fixed messages, object IDs, trees and parent relationships**, plus protocol/authentication traffic. A public journal exposes these metadata, including your configured email.

The dedicated profile directory contains the HMAC key, queue/state/transactions, config, receipts, raw original client-setting backups and the journal repository. It receives current-user Windows ACLs; administrators, other user-privileged processes and backups are outside this protection. Original settings backups may contain secrets. Uninstall retains these files and history for inspection.

`local` and `preview` execute no journal Git network operations. Source installation downloads locked dependencies through npm; client MCP commands and ordinary AI-client use can have separate network behavior. `enable-sync` checks empty HTTPS destinations and authorizes future batches. The worker processes approximately every minute. A primary and optional approved mirror receive the same audited history, with independent checkpoints and retries. Editing configuration or resuming does not authorize a new mirror. There is no all-refs mirror, force push, tag upload or recursive submodule publication.

All project subprocesses are centralized in `src/transport.ts`. Git uses fixed arguments and isolated settings; allowlisted standard credential helpers can contact additional authentication services. Private send manifests/receipts disclose destinations, outgoing objects, helper settings and observed operation results; they are not uploaded journal content or independent server attestations.

Preview audits the whole owned root history before printing pending commits, including intermediate contents and identity metadata. Only fixed WORKLOG content, ordinary appends, and deterministic legacy display conversions pass. Other edits, deletions, incorrect daily counts, mixed styles and downgrades are rejected without printing the sensitive patch. Manually committed private content still exists in local Git objects; rejection does not erase it.

The current-user background task uses a small locally compiled GUI launcher. Its readable fixed C# source is embedded in `transport.ts` and saved beside the executable in the private directory. It starts only the configured Node/CLI/config command, waits and returns its exit code, with no console or launcher download. Source/import tests cover the project's seven modules; they do not audit dependencies, external binaries, OS permissions or every real client version. Read the source, perform the README's local test and inspect preview before enabling upload.
