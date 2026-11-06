# 006 Deployment

Use this guide to install, configure and operate dsh-superagent. It covers accounts, startup checks, upgrades and troubleshooting, building on [001 Domain model](001-domain.md) through [005 Panel](005-panel.md).

## What runs

- **A dedicated DeepSeek Harness profile**, called `superagent` in this guide. Create it from the Web profile template. It loads the bundle and serves its panel on `127.0.0.1`. Keep it separate from the profile you work in: the plugin changes process-wide `PATH` and git settings, and its process needs independent restarts and upgrades.
- **An agent GitHub account.** The agent comments, pushes branches and opens pull requests as this account, through a GitHub CLI signed in only as that account.
- **Optional:** a Feishu bot for chat requests.

Plugin configuration holds the state directory and machine limits. Use the panel for everything else: Sources for the repository and accounts, Policy for allowed lists, and Execution for worker directories and commands.

### Permissions and isolation

The bundle defines `dsh-superagent-worker` for Executors and `dsh-superagent-router` for the main Session. They appear in the DeepSeek Harness preset list but are intended only for dsh-superagent. Do not select them for personal Sessions or disable their configuration rows. The application needs them to create and resume its Sessions.

Opening a blank managed Session in the Web UI can select the profile's default preset. dsh-superagent restores its role-specific preset before the first turn.

Both presets run with `danger-full-access` as the operator's OS user and read messages from subscribed Threads. Account wrappers choose the agent's credentials by default; they do not isolate the process. A worker can execute programs by path and read the operator's home directory. For isolation, use a dedicated OS account containing only the agent's credentials.

## Prerequisites

- Node.js 22.19+ or 24+, pnpm, git 2.32+, Python 3.8+ and tmux
- GitHub CLI (`gh`) 2.48 or later. Source CLI fields must point to `gh` or `lark-cli` wrappers; the host relies on their subcommands and output formats.
- A repository on github.com; GitHub Enterprise Server is not supported. To create a checkout per Ticket, keep a local clone from which the prepare command can add worktrees. Install `git-lfs` if that repository uses Git LFS.
- A model provider configured for DeepSeek Harness. dsh-superagent uses the profile's default model unless the Eval or Execution settings name another.
- For Feishu: `lark-cli` (tested with 1.0.90) and a Feishu or Lark app with a bot

## Accounts

### Agent GitHub account

1. Create a GitHub user account for the agent and give it write access to the repository. A GitHub App cannot be the agent, because dsh-superagent reads the account's notifications.
2. Give it a GitHub CLI that uses only its own credentials:

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   Sign in as the agent account; the last command prints its login. dsh-superagent reads the login the same way.

### Feishu bot (optional)

1. Create a self-built app with the bot capability. Grant it the permissions to receive message events, read and send chat messages, and read chat members, then publish the app version.
2. Give the bot its own `lark-cli` configuration, restricted to the bot identity, and a wrapper:

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   The first command reads the app secret from standard input. Use a separate configuration directory: `lark-cli` allows one profile per app id, and your personal configuration may already contain a user login for that app.

   The host refuses a CLI that can act as a user. It reads the app id, Feishu/Lark brand and bot `open_id` from the bot configuration.

   Both configurations share the keychain entry for the app secret. To remove only the bot configuration, delete its directory; do not run `lark-cli config remove`, which would affect the shared secret.

## Install

Run this block once, on a machine that has no `superagent` profile yet:

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

The pinned version above is public; other versions must satisfy `engines.dsh` in `package.json`.

The fourth command creates `~/.dsh/profiles/superagent` from the DeepSeek Harness Web template. The fifth installs this bundle. Set `DSH_HOME` to relocate the default `~/.dsh` directory.

Run the profile-creation command only for a new installation. If the profile already exists, that command replaces it and deletes its `cordis.patch.yml`, including machine configuration. Do not use it for upgrades.

## Machine configuration

Copy [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) to `~/.dsh/profiles/superagent/cordis.patch.yml`, replacing that file, and replace every `<placeholder>`. For Feishu, also enable the `dsh-superagent-feishu` entry there. The `webserver` entry sets the panel's port.

| Key | Required | Meaning |
| --- | --- | --- |
| `stateDir` | yes | Absolute path: the database, the lock, the command shims in `worker-bin`, the agent's git configuration and, by default, the Ticket directories in `work`. Back it up before upgrades |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | no | The largest saved prompt configuration, and how many Thread pages one assessment reads within what time |

After the first start, edit machine limits in **Settings → Deployment** or the DeepSeek Harness Plugin Manager. Changes apply without restart. `stateDir` cannot be changed there. Invalid values or unknown configuration keys prevent startup; the log identifies the key.

## Start and stop

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

`start` runs `dsh --profile superagent` in tmux session `dsh-superagent`, or `dsh-<profile>` for another profile. It waits up to one minute for the runtime to become ready or report a setup requirement. On a first run it prints the missing setup information. It refuses duplicate instances, including ones started outside this script.

`stop` and `restart` request graceful shutdown and wait up to five minutes for Executors. They never force-kill the process or touch other tmux sessions.

`status` prints process ids, health and setup problems. For a different profile or port, use `--profile` and `--url`, or set `DSH_SUPERAGENT_PROFILE` and `DSH_SUPERAGENT_URL`.

`status`, `start` and `restart` exit with one of four codes:

| Code | Meaning |
| --- | --- |
| 0 | The service runs normally |
| 1 | It does not run, runs twice, does not answer, or its runtime reports an error; a restart may fix it |
| 2 | It runs, but a part other than the runtime, such as a Source or a Policy sync (`sync:<source id>`), reports an error; a restart does not fix it |
| 3 | It runs and waits for setup; a restart does not fix it |

A Source that is still starting counts as normal operation. So does a Feishu bot that setup could not check.

`status` returns failed parts and their details under `errors`, and setup requirements under `setup`. `start` and `restart` print those problems as lines; they exit 1 if the service never comes up. Only an intentional `stop` pauses automatic recovery.

Each profile stores logs and control files under `.artifacts/`:

- Startup logs: `dsh-superagent-<profile>-<date>-<time>-<pid>.log`, where the pid belongs to the script. The newest 20 are kept.
- Control files: `control/profiles/<profile>/`, containing the stop marker, lock and process id.

Open the URL printed in the log, then choose **Superagent** in the sidebar.

### Hourly check

Create the hourly check in the DeepSeek Harness profile you normally use, not in `superagent`. It must keep running when the agent service is down. Ask an agent in that profile to create an hourly schedule using this prompt, with the checkout path filled in:

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile superagent status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` preserves an intentional stop. Only `stop` writes the marker; `start` clears it. `restart` writes no marker, so the check can recover a restart whose shutdown timed out.

## Settings

Setup must succeed before polling or work starts. Overview lists missing requirements and links to their settings. A settings change runs setup again. If you fix something outside the application, such as CLI authentication, choose **Check again**.

1. **Sources.** Set the GitHub repository (`owner/name`) and agent CLI, for example `/home/me/.local/bin/gh-agent`. Requests normally arrive through the agent account's notifications. A new Issue or comment mentioning the account arrives on the next poll; adding a mention by editing an existing Issue body does not. Post a new comment instead. For Feishu, set the bot CLI, chats, each chat's receive-all or mentions-only mode, and whether to receive direct messages.
2. **Policy.** The two example rules can be edited or removed. Under **On each Source**, add the GitHub accounts and Feishu users who may ask for work; until a list has someone, no request can become a Ticket. With Feishu, a chat can be chosen to sync the list from, at startup and on **Sync now**.
3. **Execution.** The directory root and a prepare command. To give each Ticket a checkout of the repository:

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   List personal CLIs, such as one signed in to your own account, as blocked commands.
4. **Prompts.** Set the team sections: the GitHub disclosure line, review bots, the commit author and the auto-merge condition.

### Management API

The panel uses a local HTTP API that agents can also call. `SETUP.md` uses it to save settings, and the service script reads `GET state`.

Send requests to `http://127.0.0.1:<port>/orchestrator/api/` with `x-orchestrator-request: 1`. The host must be `127.0.0.1:<port>` or `localhost:<port>`. Missing headers or an `Origin` from another site receive 403.

API saves have the panel's permissions. They can change execution environment and setup account fields, unlike saves made through the main Session's tools.

Agents may rely on these routes and fields. The other routes in `src/app/api.ts` serve the panel and change with it.

| Request | Answer |
| --- | --- |
| `GET state` | What every page reads: `setup`, with `problem` and `feishuProblem`, each `null` or a setup problem with `place`, `code`, `values` and `detail`, and `accounts` once setup resolved them; `health`, an entry per part, below, with `state` (`starting`, `ready`, `paused` or `error`), `detail` and `at`; `load`, the Executor Sessions `running`, the Tickets `queued` and `maxWorkers`; `paused`; and `masterId` |
| `GET settings` | `blocks`: `policy`, `eval`, `executor` and `jira`, each with its `value` and its `revision`; `sources`: the Source instances, each with `id`, `kind`, `installed`, its block's `value`, `{"enabled": …, "config": {…}}`, and `revision`, its kind's form, and its setup `problem` when it has one; `policyVersion`; and `environment`, the execution environment's `root` and `variables` |
| `GET sources` | Each Source's status: `state` (`missing`, `off`, `error`, `setup`, `starting`, `paused` or `ready`), the `health` of its parts, its setup `problem`, the last day's `stats`, the Triggers it `filtered` in that day, and the messages it `dropped` in that day, newest drop first, each with its `channel`, `preview`, `ticket` (`id` and `title`) when it was for one, its `thread` when the store has it, and `dropped.at` and `dropped.reason`, `channelGone` or `channelIgnored` |
| `PUT settings/<block>` with `{"value": …, "revision": n}` | Saves one block: `saved`, the block's new `revision`, `policy_changed` and `restarting`. `value` is the whole block, as `GET settings` holds it; a missing key takes its default |
| `POST executor/pause` with `{"paused": true}` or `false` | Pauses or resumes processing: `paused` |
| `POST setup/check` | Runs setup again by restarting dsh-superagent: `restarting: true`. Refused when setup has nothing to fix |
| `POST policy-sync/<source id>` | Syncs that Source's allowed list now: `policy`, the Source's part as saved |
| `GET prompts`, `PUT prompts` with `{"config", "baseRevision"}` | Reads the prompt configuration: `current`, with its `revision` and `config`, `defaults`, `sections`, the team sections in the order Sessions read them, `skillName`, the pattern of a team skill's name, `builtin`, the names a team skill cannot take, and `skillPrefix`, which Sessions load a skill's name under. Or saves it: the new `revision` |
| `POST tickets/<id>/retry`, `POST tickets/<id>/stop` | Retries or stops a Ticket, as the panel does |

Health entries are grouped by responsibility:

| Entry | Reports |
| --- | --- |
| `runtime` | The application itself |
| `models` | Sessions waiting on a model-budget retry |
| `evals` | Unavailable Evals from the last hour with no later judgement or dismissal |
| `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply`, `jira` | Stored work described in [003 Execution](003-execution.md); delivery counts waiting work, while reply covers Channel messages |
| `worker` | Executor Session event handling; appears after its first failure |
| `github`, `feishu`, `history` | Source polling, events and history recovery |
| `sync:<source id>` | Allowed-list synchronization |

A refusal has a status and `error`, its English text:

- 400: an invalid value (`issues`, each with its `path`), a failed account check (`setup`), a fixed refusal (`code` and `values`), or a body that is not JSON or is too large.
- 404: something that does not exist.
- 409: a stale revision.
- 500: anything else.

The blocks:

- `source:github`, `source:feishu`: `{"enabled": true, "config": {…}}`. GitHub's config has `repository` and `cli`, and the switches `observeIssues`, `observePulls`, `observeComments` and `observeCi`, off by default, which receive every new Issue, new pull request and comment in the repository and the default branch's CI; Feishu's has `cli`, `chats` as `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]` (or `"all"`), `directMessages`, and `otherChats` as `"none"` or `"mentions"`.
- `policy`: `{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`. `bots` lists the bots whose messages may become inferred candidates. An `admission` row is keyed by chat id, `other` or `direct` for Feishu, and by `issues`, `pulls`, `comments` or `ci` for GitHub; an unset cell takes its default (see [002 Authorization](002-authorization.md)).
- `eval`: `mode`, `timeoutSeconds` and `model`.
- `executor`: `model`, `maxWorkers`, `directory`, `prepare`, `blockedCommands` and `concurrentWrites` (local workspace mode only, default `false`). The processing pause is a setting of its own, `paused`, which `POST executor/pause` sets.

Changing a repository or CLI runs the corresponding setup check first. A failed check returns 400 with details in `setup`. A successful account change, or any save while setup is pending, returns `restarting: true`. The API is temporarily unavailable while the application restarts.

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

## Setup checks

Setup uses the DeepSeek Harness subprocess service, as worker shells do. It removes environment variables whose names contain KEY, PASSWORD, SECRET or TOKEN.

Setup verifies the GitHub repository and the agent's push access, writes the worker environment, and checks that git uses only the agent credentials for github.com. A Feishu setup failure disables only the Feishu Source.

The process environment that setup writes:

- **Command shims** in `<stateDir>/worker-bin`, first on `PATH`: `gh` runs the agent's CLI; `lark-cli` runs the bot's CLI; blocked commands fail. A shim removes its own directory from `PATH` before it runs its target.
- **git configuration** in `<stateDir>/worker-gitconfig`: replaces the operator's global and system git configuration. It selects the agent CLI as the github.com credential helper, rewrites GitHub SSH addresses to HTTPS and defines Git LFS filters. Personal git settings such as an HTTP proxy do not apply. No commit identity is set here, git never prompts for credentials, and `GH_TOKEN` and `GITHUB_TOKEN` are removed.

A file in `worker-bin` or `worker-gitconfig` that dsh-superagent did not write stops setup. A Ticket directory inside a git repository whose own configuration adds credentials fails the Ticket.

## Try it

From an allowed GitHub account, open an Issue or post a comment containing `@<agent login> <request>`. Within a polling interval (one minute by default), Overview should show a Ticket. The agent acknowledges the request, works in its own Session and directory, and delivers in the original conversation. For Feishu, mention the bot in a configured chat.

## Upgrade

1. Wait until no Executor is in the middle of a turn.
2. Back up `<stateDir>/orchestrator.sqlite`.
3. Run `git pull && pnpm install && pnpm build`.
4. Run `scripts/dsh-superagent restart` and inspect its status.

A restart ends running Assignments and starts replacements with recovery notes. Team text and overridden prompt parts are retained; parts without overrides follow the new defaults. Review parts marked **Default updated** after upgrading.

A database migrated by a newer version cannot be opened by an older one. Rollback therefore requires the pre-upgrade backup. After upgrading DeepSeek Harness itself, restart the running instance so the panel loads matching artifacts.

### Agent presets

The worker and router presets move shell commands to the background after 5 seconds. A Session cannot load without its preset. Keep the `dsh-superagent-worker` and `dsh-superagent-router` rows in `cordis.patch.yml` while their Sessions are in use; otherwise resume fails with `agent-preset/not-found`.

## Troubleshooting

Setup problems appear on the overview with a link to the fix, in the panel's language; the log and the API show the English text below.

| Symptom | Cause and fix |
| --- | --- |
| `The agent GitHub CLI is not set.` | Set the agent's CLI on the GitHub card |
| `The agent GitHub CLI was not found.` | Set the wrapper's absolute path, or a command name on `PATH` |
| `The agent GitHub CLI cannot read its account` | Sign the wrapper in with `auth login` |
| `@… cannot read …` or `@… cannot push to …` | Give the agent account write access to the repository |
| `The GitHub Source names no repository.` | Set the repository, `owner/name`, on the GitHub card |
| A Ticket fails with `The prepare command failed: …` | The output names the cause, such as a wrong clone path; fix the command, then retry the Ticket |
| `git does not read the github.com credential configuration dsh-superagent writes` | Install git 2.32 or later |
| A Ticket fails with `The git configuration of the repository in … sets …` | Remove the named credential or `http.*.extraheader` settings from the clone's `.git/config` |
| `… was not written by dsh-superagent` | Move the named file out of `<stateDir>/worker-bin` or `<stateDir>/worker-gitconfig`, or choose another `stateDir` |
| `The bot lark-cli allows user identities` | Point the Feishu Source at a bot-only configuration, as in Feishu bot above |
| `The bot lark-cli does not work.` or `The bot identity of app … is …` | Check the configuration's app id and secret |
| `The Feishu bot is not a member of the chat.` | Add the bot to the chat in the chat's settings; the next attempt succeeds |
| `status` exits 2 | A part reports an error, which a restart does not fix: `errors` names each part, as listed under Management API, with its detail; each part clears its own entry once it works again |
| `status` exits 3 | Setup waits: `setup` says what is missing, and the overview links to the setting that fixes it |
| `status` exits 1 | The service does not run, runs twice, does not answer, or its runtime reports an error; the output and the newest log say which |
| `… timed out after 90 s`, `… was stopped by …`, `… exited with code …` or `… could not run: …` | A CLI failed without printing why; run the named program by hand as the operator's user to see its own message |
| The panel says dsh-superagent is not answering | It is restarting, or did not start because of its configuration; the DeepSeek Harness log names the cause |
| `dsh-superagent configuration has keys it does not use` (log) | Remove the named keys; the message says where each value lives now |
| The log says the plugin is incompatible with the running dsh | Install a DeepSeek Harness version within the `engines.dsh` range |
| The panel shows "Failed to load plugins" after a DeepSeek Harness upgrade | Restart the running instance |
| Nothing happens after a mention | Check that the author is on the Source's allowed list, the Source is on, and processing is not paused. On GitHub, a mention added by editing an Issue's body is not received; mention the agent in a comment |


## Local workspace mode (local adaptation)

This build adds an optional `localWorkspace` machine setting. Leave it empty for the upstream GitHub workflow. Set it to an existing absolute directory to work directly in a local, possibly multi-repository workspace:

```yaml
- id: dsh-superagent
  config:
    stateDir: /absolute/path/to/state
    localWorkspace: /absolute/path/to/existing/workspace
- id: dsh-superagent-github
  disabled: true
```

In this mode no GitHub account or repository is required. Keep the Feishu Source and its bot-only CLI configured as above. Disable the GitHub Source as well; this is a local execution mode, not a GitLab event or merge-request integration.

The workspace must already exist. The host does not create a clone or repository. Tickets ignore the prepare command. Read-only tickets use the existing directory directly and may run concurrently per project. By default (`executor.concurrentWrites` off) write tickets also use the project directory with exclusive project access and no worktree or branch is created. With **Execution → Concurrent writes per project** on at acceptance, a write ticket whose group-bound project is a git checkout with at least one commit gets its own `git worktree`, created serially per repository from the project's HEAD on branch `superagent/<ticket id>`, under `<stateDir>/local-worktrees` (independent of `executor.directory`), outside the project; such tickets run concurrently with each other and with readers, and reuse the worktree for follow-ups, resumes and restarts. The choice is frozen on the ticket: after the setting is turned off, tickets with a worktree keep using and cleaning it up, and new ones are exclusive. Other write tickets, and any whose worktree cannot be created, use the project directory with exclusive project access, including human follow-up wakes. Different bound projects can run concurrently up to `executor.maxWorkers`. Unbound write tickets and legacy tickets exclusively lock the shared workspace. An invalid or missing workspace fails setup. Existing branches, remotes and user changes remain in place. Read the workspace and nearest child repository instructions before changes. Analysis requests are read-only; local modifications require an explicit request. Commits, pushes, merge requests, publishing and deployment require explicit authorization.

Only the operator's allowed Feishu account should be admitted initially. `observe` still permits explicit requests; it prevents inferred work from being executed automatically. Keep the DSH host running and online for event reception. Group use additionally requires the bot to join the selected group; private chat requires the same account allowlist.

This is a local modification of the research prototype. Preserve the source patch when upgrading. Build with the pinned package manager, run `pnpm check`, then install a built tarball; installing the unbuilt upstream GitHub source loses this adaptation and may omit `lib/`.


## Local group-to-project routing

For installations using `localWorkspace`, configure **Sources → Feishu → Chats → Project directory** (`projectPath`) with an existing absolute project path for each group. Each configured project directory can be assigned to one listed group. New tickets store the canonical path and use it for both the worker Session workspace and `DSH_SUPERAGENT_LOCAL_WORKSPACE` / `DSH_SUPERAGENT_PROJECT`. This selects a project; it does not create a filesystem sandbox.

Changing a binding does not move existing tickets or their Sessions. A missing, unreadable or replaced project directory prevents execution instead of creating a replacement or selecting another project. Chats without a binding and direct messages keep the installation's existing default workspace. On explicit acceptance the router sets `access` to `read-only` for investigation, explanation, review or a proposed plan requiring no file changes, otherwise `write`. Missing access means write, including legacy tickets. Access is frozen on the ticket and survives resume; modification follow-ups must be handed back to a separate write ticket. Read-only workers and their subagents are pinned to the host read-only file sandbox before execution, with file-write tools and shell sandbox escalation denied; a missing sandbox policy fails execution instead of running unconfined. This constrains local file effects, not remote database or network writes. CLI caches, build outputs and other file writes are also blocked.

Project locks cover starting workers, active turns, and their background work. Read-only tickets share locks and worktree-isolated writers take none; any other writer excludes both readers and writers on overlapping roots. After a ticket ends, a clean worktree whose branch has no commit outside HEAD is removed with its branch; one with uncommitted changes or unmerged commits stays until a person merges or removes it (`git worktree remove`, `git branch -D`). Overlapping project roots share a lock. The global `executor.maxWorkers` limit still applies; a queued ticket waiting for its project does not prevent an independent project from starting. Unbound write tickets and legacy tickets, whose project was never frozen, run exclusively without changing their original directory.

### Services under a group project

A group binding can list services inside its project. Each service is a `name` and a `path` relative to `projectPath` (no `..`). The saved list is the source of truth. **Sources → Feishu → Chats → Discover services** suggests candidates and does not save them until you save the form: child directories that are their own git repositories, or, when the root is one git repository and no child is, the top-level directories except shared names such as `docs`, `openspec`, `scripts`, `logs`, `tmp` and `output`.

Two layouts:

```json
{
  "chatId": "oc_shop",
  "listen": "mentions",
  "projectPath": "/Users/me/work/shop",
  "services": [
    { "name": "shop-account", "path": "shop-account" },
    { "name": "shop-pay", "path": "shop-pay" },
    { "name": "shop-gateway", "path": "shop-gateway" },
    { "name": "shop-web", "path": "shop-web" },
    { "name": "shop-app", "path": "shop-app" },
    { "name": "shop-site", "path": "shop-site" }
  ]
}
```

`shop` is not itself a git repository. Each service is a sibling repository. Non-git directories such as `docs` stay shared files, not services.

```json
{
  "chatId": "oc_admin",
  "listen": "mentions",
  "projectPath": "/Users/me/work/admin",
  "services": [
    { "name": "admin-server", "path": "admin-server" },
    { "name": "admin-common", "path": "admin-common" },
    { "name": "admin-web", "path": "admin-web" }
  ]
}
```

`admin` is one git repository. The services are lock scopes inside that checkout. `docs`, `openspec`, `scripts`, `output` and `logs` are not services.

When the candidate card lists `project_services`, accept with `services` set to the names the request touches (one or several; one ticket may span services). Omit `services`, or pass `["*"]`, when the request is unclear or covers the whole project. The choice is frozen on the ticket's execution, like `access`. A group with no `services` does not show the list, and the field is ignored: the lock stays `projectPath`, as in 0.1.0-local.10.

Lock rules:

- Read-only tickets share with other read-only tickets. A reader conflicts with a writer only when their scopes overlap.
- Write tickets on different services run in parallel. The same service is exclusive while `executor.concurrentWrites` is off, and runs in separate worktrees while it is on.
- A ticket that names several services acquires every one of them in one step, so two overlapping tickets cannot deadlock.
- A whole-project ticket's scope is `projectPath`, so it conflicts with every service ticket that is using the shared checkout.
- Writers whose services are subfolders of one git checkout are exclusive with each other even when the paths do not overlap, unless each is isolated in its own worktree. They share that checkout's git index, HEAD and branch, and workers may run git. File-disjoint edits are not enough. With `concurrentWrites` on, a monorepo ticket gets one worktree of the repository (not one per subfolder) and does not lock the checkout.
- With `concurrentWrites` on, a multi-repo write ticket gets a worktree only for each touched repository that has a commit. The worker's directory is `<stateDir>/local-worktrees/services-<hash>/<ticket name>/`, with each service's worktree under its name and symlinks to the project's shared non-git files. Other git repositories are not linked. Cards, worker reports and ready replies list each worktree path and branch (`superagent/<ticket id>` on every repository). Follow-ups, resumes and restarts reuse them. Cleanup removes only a clean worktree with no commit outside that repository's HEAD, then removes the aggregate directory when nothing remains. Symlink targets are not deleted.
- A service that is not a git repository, a repository with no commit, or a worktree that cannot be created degrades to exclusive access for that service. The worker does not start in the shared directory until that lock is held.

Existing tickets have no `services` field and keep their project lock. GitHub mode and the outbox are unchanged. Adding or editing a group's services affects only tickets accepted afterward.

## Feishu replies rooted at an accepted reply

A Feishu request may itself reply to a forwarded message. The bot then replies in a new topic rooted at that request. Incoming topic replies associate that topic with the ticket whose originating request is the retained root/parent message, within the same source chat. Other tickets sharing the earlier quoted thread are not added. The association is also repaired during duplicate history reads, without delivering the same input twice. Human-stopped tickets do not gain new topic subscriptions. Existing ticket follow-ups use their own admission and access; unrelated unmentioned messages remain inferred candidates constrained by the enabled rules.

## Jira Server / Data Center (optional, local.12)

Jira is a one-way integration from Superagent to your self-hosted Jira Server / Data Center, using REST API v2. It is disabled by default. GitHub tickets, direct messages and unmapped groups do not enroll automatically. No old ticket is scanned or backfilled at startup, configuration save, resume or report. A group must exist under `sources.feishu.config.chats` and have a Jira mapping.

### 1. Create the integration credential

Use a dedicated Jira account with Browse Projects, Create Issues, Add Comments and Transition Issues permissions on each mapped project, plus assignment/component permissions when those optional fields are configured. For Jira Data Center 8.14+ open the account’s **Profile → Personal Access Tokens**, create a token and choose its expiry according to your team’s policy. The integration sends it as `Authorization: Bearer …`.

If PAT authentication is unavailable on your Server/DC version, select **Basic** explicitly and enter the Jira username. The referenced secret then contains that account’s password. There is no automatic downgrade from Bearer to Basic and no Jira Cloud API-token assumption.

### 2. Put the secret on the DSH host

Create the directory as the OS account running DSH, and write the token using an editor or your secret manager:

```sh
mkdir -p ~/.config/dsh-superagent-jira
chmod 700 ~/.config/dsh-superagent-jira
# Write the token into ~/.config/dsh-superagent-jira/token without putting it in a shell command/history.
chmod 600 ~/.config/dsh-superagent-jira/token
```

The default reference is `{"kind":"file","path":"~/.config/dsh-superagent-jira/token"}`. `~` resolves to the DSH process user’s home. Absolute paths are also accepted. A non-regular file, an unreadable file, a file over 16 KiB, an empty value or a multiline credential fails safely. Permissions broader than `0600` produce a warning in the connection test and Jira page after the next credential read. The plugin never changes that file.

Alternatively set the credential in the DSH process environment and configure `{"kind":"env","name":"DSH_SUPERAGENT_JIRA_TOKEN"}`. The process must actually inherit that variable: setting it in a separate terminal after DSH started has no effect. Token rotation in a file is picked up on the next operation.

Only the reference is saved. The secret is never a settings field, settings-history value, SQLite record, worker prompt, panel response or browser request. Remote error bodies and authorization headers are not logged or returned. Redirects are refused to keep the credential on the configured server.

### 3. Map groups to Jira projects

Open **Settings → Jira**. Enter your base URL including any context path, such as `https://jira.example.org/jira`, with no credentials, query or fragment. Add a row for each configured Feishu group: project key, issue type (`Task` by default), optional comma-separated labels/components, and an optional assignee **Jira username**. Choose exactly one Jira project per group; several groups may share a project. Groups without rows do not sync.

Example complete `jira` settings block (references and placeholders only):

```json
{
  "enabled": true,
  "baseUrl": "https://jira.example.org/jira",
  "auth": "bearer",
  "username": "",
  "secret": { "kind": "file", "path": "~/.config/dsh-superagent-jira/token" },
  "panelUrl": "http://127.0.0.1:3082/",
  "mappings": [
    {
      "chatId": "oc_team",
      "projectKey": "TEAM",
      "issueType": "Task",
      "labels": ["superagent"],
      "components": ["API"],
      "assignee": "jira-bot"
    }
  ],
  "transitions": {
    "working": "Start Progress",
    "blocked": "Block",
    "failed": "Block",
    "ready": "In Review",
    "completed": "31",
    "merged": "31",
    "stopped": "Stop Progress"
  }
}
```

Replace every example workflow transition with one your Jira workflow actually exposes. `panelUrl` is optional and defaults to the DSH loopback web URL; set a reachable panel URL for your team if needed. Its `superagentTicket` query opens the ticket when the Superagent panel mounts. The description also includes the original Feishu request and its source link, group, frozen services and read-only/write access. Source-link lookup failures do not prevent issue creation; the retained request is always included.

Save through the panel, or `PUT settings/jira` using the block’s revision from `GET settings`, with `{"value": <block above>, "revision": <current revision>}`. Settings validation refuses inline `token`, `password` or unknown fields before persisting anything. Turning Jira on does not require a DSH restart.

### 4. Test authentication and configure transitions

Save the configuration, choose a mapped project and click **Test connection**. Optionally enter a representative issue key from that project. The test calls `/myself`, reads the project’s issue types, and lists the sample issue’s currently available transition names, IDs and destination statuses. If no sample is supplied, it uses the most recently updated readable issue. An empty project has no sample transitions: create an ordinary test issue in Jira first. The connection test does not create or mutate issues.

Jira transitions are specific to an issue’s current workflow state; REST v2 does not expose a universal project-wide transition list. Inspect representative issues in the other workflow states as well. Map Superagent states `accepted`, `working`, `waiting`, `blocked`, `failed`, `ready`, `completed`, `merged`, `closed`, `dropped` and `stopped` to the transition **name or ID**, not the destination status ID. Blank means no transition. Configure transitions that require no additional interactive field input. An unavailable transition remains queued with an actionable error rather than silently dropping the state change. `ready` means a report is ready while the ticket awaits review/PR; `completed` is a ticket completed without waiting for a PR. Mapping changes affect pending operations and future changes.

### 5. Operate and recover

At acceptance, mapped new tickets enroll atomically with their Jira journal and `jira` effect. Each issue has a stable `dsh-sa-…` label. Keep this label intact: it recovers a create whose response was lost. Jira is processed with concurrency **2**, independent of workers and other effects, and uses the existing retry backoff (5 seconds doubling to 5 minutes) and pause/Later behavior. Operations remain ordered per ticket, even when a report arrives while a request is in flight. Disabling Jira or pausing processing holds synchronization; re-enabling resumes its durable queue. The issue mapping and base URL are frozen for enrolled tickets; changing the base URL pauses their sync with an error until it is restored, preventing an old issue key being sent to a different server.

Failure/ready-result/completion comments contain the report summary, recorded branches/worktrees, execution directory and PR links from the report or followed threads. Comments carry a stable operation marker and recovery reads every comment page. Current status is checked before replaying a transition with a lost response. Jira keys link from ticket cards/detail pages and Feishu replies sent after the key is known. Host-added links sit outside the authored reply’s 100-word budget. GitHub replies are unchanged.

A failed sync appears on its ticket immediately and in `health.jira` after three consecutive effect failures. It never ends, blocks or fails the Superagent ticket. A successful retry clears the ticket error and health. The **Jira** tab queries only through the backend: select all mapped projects or one, use assigned/reported/open/done filters, text or raw JQL, page the list, refresh the 15-second bounded cache, or group the current page by status. “Assigned to me” and “reported by me” refer to the Jira account behind the configured credential. Issue links open Jira in a new tab; linked records also offer **Open Ticket**. Jira reads do not create Superagent tickets.

Older tickets require **Sync this ticket to Jira** on their detail page. This explicitly enrolls that one ticket with its current state/result. Use the same action to wake a pending retry after fixing configuration or connectivity. It never scans other tickets.

Jira REST v2 provides no general atomic create idempotency key. Before creating, the plugin searches the stable label and durably records a send intent. If the response is lost, a restart happens between intent and acknowledgement, or a server error leaves the write outcome unknown, it **only searches for recovery** and does not blindly create again, even while Jira indexing is delayed. The same conservative rule applies to comments with an unknown outcome. A definite 4xx rejection can retry automatically.

If recovery cannot find the record, inspect Jira first. On the ticket, enter an existing issue key and click **Sync this ticket to Jira** to restore its association. If you have positively confirmed that the issue or pending comment was never created, use **Confirm absence and resend**. This explicit confirmation permits another write; an incorrect confirmation can create a duplicate. Do not remove marker labels or retry an unknown create blindly. No automatic retry can guarantee both progress and absence of duplicates after a lost response without Jira-side idempotency support.

Additional local API routes:

| Request | Meaning |
| --- | --- |
| `GET jira` | Enabled flag, mapped project keys and latest credential-file warning; no secret |
| `POST jira/test` with `{"project":"TEAM","issue":"TEAM-1"}` | Authenticated display name, issue types and the sample issue’s current transitions; `issue` optional |
| `GET jira/search?project=TEAM&filter=open&startAt=0&maxResults=25` | Project-scoped issue list, `total`, `startAt`, `next`; project optional; filters `all`, `assigned`, `reported`, `open`, `done`; optional `text`, `jql`, `refresh=1`; maximum 100 per page |
| `POST tickets/<id>/jira` with `{}` | Explicitly enroll or retry one ticket |
| Same route with `{"issueKey":"TEAM-1"}` | Associate a confirmed existing issue in the enrolled project |
| Same route with `{"retryUncertain":true}` | Human-confirmed absence permits resending an uncertain create/comment |

All use the existing loopback/same-origin protections. Secrets are loaded only server-side, and the backend never serves arbitrary target URLs.
