# opencode-ssh

A native **OpenCode V2** plugin that runs `read`, `write`, `edit`, `bash`, `ls`, `grep` and `find` on a remote machine over SSH. It is a rewrite of [`pi-ssh`](https://github.com/hakergeniusz/pi-ssh) for OpenCode: no pi runtime packages are imported.

The local project directory is **mapped** onto the remote working directory. Opening `src/index.ts` reads `<remote-cwd>/src/index.ts` over SSH, and search results are translated back into the same local path space. Absolute paths outside the mapped directory (e.g. `/etc/hosts`) are used on the remote host as-is.

While connected, the seven tools replace OpenCode's stock `read`/`write`/`edit`/`bash` and add `ls`/`grep`/`find`. While disconnected, they are **not registered**, so stock OpenCode tools remain in charge and idle sessions pay no extra tool-schema tokens.

## Load and configure

Load it as a plugin and pass the connection through plugin options:

```jsonc title="opencode.jsonc"
{
  "plugins": [
    {
      "package": "opencode-ssh",
      "options": {
        "target": "deploy@build-box:/srv/app",
        "allowLocal": false,
        "shell": "/bin/bash",
        "sshOptions": "-i ~/.ssh/id_ed25519 -J bastion"
      }
    }
  ]
}
```

A local checkout works too:

```jsonc
{
  "plugins": [
    { "package": "/home/hakergeniusz/Projects/opencode-ssh", "options": { "target": "user@host" } }
  ]
}
```

Options (all optional):

| Option | Meaning |
| --- | --- |
| `target` (aliases `ssh`, `host`) | SSH destination. Same forms as pi-ssh: `user@host`, `user@host:/abs/dir`, `user@host:~/rel`, `user@host:2222`, `user@host:2222:/dir`, `user@[v6]:port:/dir`. |
| `allowLocal` | Allow the `local: ` prefix in the bash tool to run a command on this machine. Default `false`. |
| `shell` | Remote shell for every command. Defaults to `PI_SSH_SHELL`, then `bash`. |
| `sshOptions` | Extra `ssh(1)` arguments (quoted string), e.g. identities, ports, jump hosts. |

Environment fallbacks: `PI_SSH_TARGET` (target), `PI_SSH_OPTIONS` (extra ssh args), `PI_SSH_SHELL` (remote shell), `PI_SSH_ALLOW_LOCAL=1` (local escape).

Requires the `ssh` client and key-based auth; the transport uses `BatchMode=yes` so password prompts never block. Remote work runs under bash rather than the host's login shell, so a zsh default cannot change the dialect.

## Control the link

```
/ssh                  status: host, remote tools, mapping, escape hatch
/ssh on <target>      connect mid-session (same syntax as the target option)
/ssh off              disconnect; stock OpenCode tools take over again
/ssh run <cmd>        run one command remotely and show the output
/ssh local <cmd>      run one command locally, for comparison
```

## How it works / pi → OpenCode mapping

| pi original | OpenCode V2 rewrite |
| --- | --- |
| `pi.registerTool` with `create{Read,Write,Edit,Bash}Tool` + operations | `ctx.tool.transform((editor) => editor.add({ name, description, input, execute }))` with plain async functions in `src/remote-ops.ts` and `src/search.ts` |
| Remote `ls`/`grep`/`find` tool definitions | OpenCode tools built by the same code path; registered/withdrawn with the connection |
| `pi.registerFlag("ssh")`, `session_start` | plugin options / `PI_SSH_TARGET` and an initial connect in `setup` |
| `pi.registerCommand("ssh")` | `ctx.command.transform` with `/ssh` subcommands |
| `pi.on("before_agent_start")` system-prompt section | `ctx.session.hook("context", …)` pushing a text system part |
| `pi.on("session_shutdown")` | the cleanup function returned from `setup` |
| Path mapper, target parser, shell quoting, `SshSession` | kept as pi-independent modules under `src/` |
| `renderCall` tail-write preview | dropped (TUI renderer, see gaps) |

The SSH transport is unchanged in spirit: one multiplexed `ControlMaster=auto` connection, a capability probe (`rg`/`fd`/`file`) on connect, POSIX-correct quoting of every interpolated value, content written over stdin, and real remote process-group kills on abort/timeout via `context.signal`.

## Known gaps

- **No local fallback inside the tools.** When disconnected the plugin withdraws its tools so OpenCode's built-ins handle local work; it does not call them from its own executors. This preserves stock behavior without depending on another tool's internal executor.
- **Tail write preview is not ported.** The original `renderCall` replaced pi's write renderer with a tail-of-file preview (`PI_TAIL_PREVIEW*`). OpenCode plugins register tool executors, not pi `renderCall` renderers, so there is no equivalent hook; the `write` tool behaves normally.
- **Images are reported as text.** pi returned image content blocks for image files. Here a file containing NUL bytes is reported as `[binary file: … (N bytes)]`; the remote `file(1)` MIME probe is no longer surfaced as a content part.
- **`/ssh` output uses synthetic session messages** because the server part has no `ctx.ui.notify`. The status text is delivered with `ctx.session.synthetic`; it may appear as a message in the session.
- **No `user_bash` hook.** pi-ssh routed the user's `!command` shell escapes to the remote host. OpenCode has no equivalent hook in the V2 server plugin API; use `/ssh run` instead.
- **No status widget.** `ctx.ui.setStatus` (pi's TUI status line) has no server-side counterpart and no TUI part was added.
- **All seven tools appear together** while connected. The original hid `ls`/`grep`/`find` independently of `read`/`write`/`edit`/`bash`; here the whole set is registered or withdrawn at once.
- **`truncateHead`/`formatSize`** are small local reimplementations, not pi's originals; the byte budget is 30 KB and limits behave the same way.
- Timeout values are in **seconds** (`bash.timeout`), matching pi's `RunOptions.timeout`.

## Tests and development

```bash
bun install
bun run typecheck
bun test
```

The original `units.test.ts` (target parsing, path mapping, shell quoting, grep/find helpers) was ported unchanged in behavior. The original `offline.test.ts`, `remote.test.ts`, `route-write.test.ts` and `tail-write.test.ts` were **not** ported: they depend on pi's tool factories/renderers or a fake `ssh` fixture built around pi's operations API, and porting them would reintroduce pi dependencies or require the dropped TUI renderer.

## License

MIT — 2026 hakergeniusz.
