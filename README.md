# opencode-ssh

A native **OpenCode V2** plugin that runs `read`, `write`, `edit`, `bash`, `ls`, `grep` and `find` on a remote machine over SSH.

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
| `target` (aliases `ssh`, `host`) | SSH destination. Examples: `user@host`, `user@host:/abs/dir`, `user@host:~/rel`, `user@host:2222`, `user@host:2222:/dir`, `user@[v6]:port:/dir`. |
| `allowLocal` | Allow the `local: ` prefix in the bash tool to run a command on this machine. Default `false`. |
| `shell` | Remote shell for every command. Defaults to `OPENCODE_SSH_SHELL`, then `bash`. |
| `sshOptions` | Extra `ssh(1)` arguments (quoted string), e.g. identities, ports, jump hosts. |

Environment fallbacks: `OPENCODE_SSH_TARGET` (target), `OPENCODE_SSH_OPTIONS` (extra ssh args), `OPENCODE_SSH_SHELL` (remote shell), `OPENCODE_SSH_ALLOW_LOCAL=1` (local escape).

Requires the `ssh` client and key-based auth; the transport uses `BatchMode=yes` so password prompts never block. Remote work runs under bash rather than the host's login shell, so a zsh default cannot change the dialect.

## Control the link

```
/ssh                  status: host, remote tools, mapping, escape hatch
/ssh on <target>      connect mid-session (same syntax as the target option)
/ssh off              disconnect; stock OpenCode tools take over again
/ssh run <cmd>        run one command remotely and show the output
/ssh local <cmd>      run one command locally, for comparison
```

## How it works

## Known gaps

- **No local fallback inside the tools.** When disconnected the plugin withdraws its tools so OpenCode's built-ins handle local work; it does not call them from its own executors. This preserves stock behavior without depending on another tool's internal executor.
- **Tail write preview is not provided.** OpenCode plugins register tool executors (not UI renderers), so `write` returns normal output.
- **Images are reported as text.** Binary files containing NUL bytes are reported as `[binary file: … (N bytes)]`; the remote `file(1)` MIME probe is no longer surfaced as a content part.
- **`/ssh` output uses synthetic session messages** because the server part has no `ctx.ui.notify`. The status text is delivered with `ctx.session.synthetic`; it may appear as a message in the session.
- **No user `!command` routing hook.** OpenCode has no equivalent hook in the V2 server plugin API; use `/ssh run` instead.
- **No status widget.** No server-side status API/TUI part is included.
- **All seven tools appear together** while connected. All seven tools are registered or withdrawn together while connected/disconnected.
- **`truncateHead`/`formatSize`** are local reimplementations with a 30 KB byte budget and equivalent limits.
- Timeout values are in **seconds** (`bash.timeout`).

## Tests and development

```bash
bun install
bun run typecheck
bun test
```

`units.test.ts` covers target parsing, path mapping, shell quoting, and grep/find helpers.

## License

MIT — 2026 hakergeniusz.
