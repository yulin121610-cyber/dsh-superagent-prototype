# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Local workspace adaptation

This local build (`0.1.0-local.12`) also supports Feishu requests against an existing local workspace without GitHub. Configure an absolute `localWorkspace` on the main plugin and disable the GitHub Source. Read-only tasks sharing that directory can run concurrently; by default writes require exclusive access and no clone, worktree, or branch is created. With **Execution → Concurrent writes per project** (`executor.concurrentWrites`, off by default) turned on, write tasks on a group-bound git project each get a host-created `git worktree` on branch `superagent/<ticket id>` outside the project and run concurrently; other writes stay exclusive. A group can list services under its project, and a ticket then locks only the services it touches. No clone is created. GitLab remotes are preserved. This does not implement GitLab event ingestion or merge requests. See the local workspace section in `docs/006-deployment.md` in the source checkout.

## Group project bindings

In local workspace mode, each Feishu chat row can set an optional absolute `projectPath`. New tickets from that group run in the existing project directory, and their worker environment and instructions use the same project. The canonical project path is saved on the ticket; changing a group's binding affects future tickets. Existing tickets, including resumed ones, keep their execution directory. Missing or unreadable bound directories fail explicitly instead of falling back to the default workspace. Blank bindings and direct messages retain the default workspace. Different bound projects can run concurrently up to `executor.maxWorkers`; read-only investigations may share a project, and write tickets hold exclusive access, including follow-up wakes, unless `executor.concurrentWrites` is on when the ticket is accepted. The choice is frozen per ticket: turning the setting off leaves tickets that already have a worktree in it, including their cleanup, while new tickets use the exclusive flow. With the setting on, a write ticket whose bound project is a git checkout with a commit runs in its own worktree under `<stateDir>/local-worktrees/<repository>-<hash>/<name>` (not the executor directory setting) on branch `superagent/<ticket id>`, created from the project's HEAD, so write tickets on one project run concurrently with each other and with readers. Its follow-ups, resumes and restarts reuse that worktree. When the project is not a git repository, or the worktree cannot be created, the ticket runs in the project directory with exclusive access, including follow-up wakes. Once a ticket ends, its worktree and branch are removed only if they hold no uncommitted change and no commit outside the project's HEAD; otherwise they stay for a person to review and merge, and the ticket card and reports name the path and branch. Acceptance records `access=read-only` explicitly; omitted access and legacy tickets remain exclusive. The host file sandbox enforces read-only workers and their subagents, and write/escalation tool calls are denied. Unbound write tickets and legacy tickets retain exclusive use of the shared workspace.

The same chat row can list `services` under that project: a name and a path relative to the project. The saved list is the source of truth; **Discover services** only suggests candidates (child git repositories, or the top-level directories of a monorepo). At accept, `orchestrator_route` sets `services` to the names the request touches, or omits them for the whole project. That choice is frozen on the ticket like `access`. Write tickets on different services run in parallel. A ticket that names several services holds all of them. A whole-project ticket conflicts with any service ticket that uses the shared checkout. Services that are subfolders of one git checkout stay exclusive with each other unless `concurrentWrites` gives each ticket its own worktree of that repository, because they would otherwise share one git index and branch. A multi-repo ticket with `concurrentWrites` on gets a worktree per touched repository, shown together under `<stateDir>/local-worktrees/services-<hash>/<name>/`. A service that is not a git repository, has no commit, or whose worktree cannot be created keeps exclusive access to that service. Groups with no service list behave as before: the lock is the project path.

## Optional Jira Server / Data Center integration

Version `0.1.0-local.12` can sync new tickets from mapped Feishu groups to self-hosted Jira, and browse Jira issues in the panel. It is **off by default** and leaves the GitHub workflow unchanged. In **Settings → Jira**, set the base URL, a PAT file/environment reference, group-to-project mappings and transition names or IDs. The token never enters the panel or settings database. The **Jira** tab supports project selection, filters, text/JQL search, pagination and a status board. “Me” is the integration account.

1. Create a PAT in your Jira account (**Profile → Personal Access Tokens**, Jira DC 8.14+).
2. Save it on the DSH host at `~/.config/dsh-superagent-jira/token`, readable by the DSH process, with mode `0600`. Alternatively choose an environment variable reference. Never paste the token into configuration.
3. Configure each existing Feishu group’s Jira project key and issue type (default `Task`), then enable Jira.
4. Run **Test connection** and configure transitions for your workflow, using a representative issue to inspect its available transitions.

See the Jira section in [006 Deployment](docs/006-deployment.md) for the full configuration example, Basic fallback and recovery. Sync uses the durable effects queue; Jira failures never fail tickets. Existing tickets are enrolled only with **Sync this ticket to Jira**. Unknown create outcomes are reconciled before another create is allowed, preventing automatic duplicates after lost responses or restarts.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)

## Feishu topic follow-ups

When a request replies to a forwarded or quoted message and its bot conversation becomes a new topic, later topic replies follow the ticket of that exact request. Replies need no new mention; access and source admission remain enforced. New unmentioned requests outside existing ticket topics still use the configured inferred-work rules; auto mode does not accept every message.
