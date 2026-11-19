/**
 * opencode-ssh — native OpenCode V2 port of the `pi-ssh` extension.
 *
 * When connected, the `read`, `write`, `edit`, `bash`, `ls`, `grep` and `find`
 * tools are registered as OpenCode tools that execute on the remote host over
 * SSH. The local project directory is mapped onto the remote working directory,
 * so the model keeps using familiar local paths. When disconnected the tools
 * are not registered at all, so OpenCode's stock tools remain in charge (this
 * is the OpenCode equivalent of pi-ssh hiding its `ls`/`grep`/`find` tools
 * until a session is active).
 *
 * Connection is configured through plugin options (`target`, `allowLocal`,
 * `shell`, `sshOptions`) or changed at runtime with the `/ssh` command.
 */

import { Plugin } from "@opencode/plugin"
import { createPathMapper, type PathMapper } from "./path-map.ts"
import {
  accessRemoteForEdit,
  LOCAL_ESCAPE_PREFIX,
  readRemoteFile,
  resolveToolPath,
  runBash,
  runLocalBash,
  writeRemoteFile,
  type RemoteContext,
} from "./remote-ops.ts"
import { findRemote, grepRemote, listRemote } from "./search.ts"
import { splitOptionString } from "./shell.ts"
import { SshSession } from "./ssh-session.ts"
import { parseSshTarget } from "./target.ts"

const MAX_NOTIFY_OUTPUT = 2000

interface SshState {
  session: SshSession | null
  mapper: PathMapper | null
  localCwd: string
  allowLocalBash: boolean
  lastSpec: string | undefined
  error: string | undefined
  shell: string | undefined
  extraOptions: string[]
}

interface ReadInput {
  path: string
  offset?: number
  limit?: number
}
interface WriteInput {
  path: string
  content: string
}
interface EditInput {
  path: string
  oldString: string
  newString: string
  replaceAll?: boolean
}
interface BashInput {
  command: string
  cwd?: string
  timeout?: number
}
interface LsInput {
  path?: string
  limit?: number
}
interface GrepInput {
  pattern: string
  path?: string
  glob?: string
  ignoreCase?: boolean
  literal?: boolean
  context?: number
  limit?: number
}
interface FindInput {
  pattern: string
  path?: string
  limit?: number
}

const objectInput = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false as const,
})

const PATH = { type: "string", description: "File or directory path, absolute or relative to the project directory." }

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no"
}

function clip(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= MAX_NOTIFY_OUTPUT
    ? trimmed
    : `${trimmed.slice(0, MAX_NOTIFY_OUTPUT)}\n… (${trimmed.length - MAX_NOTIFY_OUTPUT} more characters)`
}

export default Plugin.define({
  id: "opencode-ssh",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Record<string, unknown>
    const localCwd =
      (ctx.location && typeof ctx.location.directory === "string" && ctx.location.directory.trim()) || process.cwd()

    let extraOptions: string[] = []
    let optionError: string | undefined
    if (typeof options.sshOptions === "string" && options.sshOptions.trim()) {
      try {
        extraOptions = splitOptionString(options.sshOptions)
      } catch (error) {
        optionError = error instanceof Error ? error.message : String(error)
      }
    }

    const state: SshState = {
      session: null,
      mapper: null,
      localCwd,
      allowLocalBash: options.allowLocal === true || process.env.PI_SSH_ALLOW_LOCAL === "1",
      lastSpec: firstString(options.target, options.ssh, options.host),
      error: optionError,
      shell: typeof options.shell === "string" && options.shell.trim() ? options.shell.trim() : undefined,
      extraOptions,
    }

    type ToolEditor = Parameters<Parameters<typeof ctx.tool.transform>[0]>[0]
    let toolRegistration: Awaited<ReturnType<typeof ctx.tool.transform>> | undefined

    function remoteContext(): RemoteContext | null {
      if (!state.session || !state.mapper) return null
      return {
        session: state.session,
        mapper: state.mapper,
        localCwd: state.localCwd,
        allowLocalBash: state.allowLocalBash,
      }
    }

    function requireRemote(): RemoteContext {
      const context = remoteContext()
      if (!context) {
        throw new Error("SSH is not connected. Use /ssh on user@host or set a target in the plugin options.")
      }
      return context
    }

    function describeSession(): string {
      if (!state.session || !state.mapper) {
        const reason = state.error ? ` (last error: ${state.error})` : ""
        return [
          `SSH mode off${reason}`,
          `Local working directory: ${state.localCwd}`,
          "Connect with: /ssh on user@host:/remote/dir (or plugin option \"target\")",
        ].join("\n")
      }
      const { session, mapper } = state
      const { rg, fd, file } = session.capabilities
      return [
        `SSH mode on: ${session.describe()}`,
        `Local ${mapper.localRoot} -> remote ${mapper.remoteRoot}`,
        `Remote tools: rg ${yesNo(rg)}, fd ${yesNo(fd)}, file ${yesNo(file)}`,
        `Local escape hatch: ${state.allowLocalBash ? `enabled ("${LOCAL_ESCAPE_PREFIX} <command>")` : "disabled (option \"allowLocal\": true)"}`,
      ].join("\n")
    }

    async function notify(sessionID: string, text: string): Promise<void> {
      // The server part has no TUI notify API; a synthetic message is the
      // supported way to surface command output into the session.
      try {
        await ctx.session.synthetic({ sessionID, text })
      } catch {
        // Headless contexts may not accept a synthetic message; output is best-effort.
      }
    }

    /** Register/withdraw the remote tools together with the connection state. */
    async function setTools(connected: boolean): Promise<void> {
      if (connected && !toolRegistration) {
        toolRegistration = await ctx.tool.transform((editor) => addTools(editor))
      } else if (!connected && toolRegistration) {
        await toolRegistration.dispose()
        toolRegistration = undefined
      }
    }

    function addTools(editor: ToolEditor): void {
      editor.add({
        name: "read",
        description:
          "Read a file on the remote SSH host. Paths under the project directory map onto the remote working directory; absolute paths outside it are used on the remote host as-is.",
        input: objectInput(
          {
            path: PATH,
            offset: { type: "number", description: "1-based line number to start reading from." },
            limit: { type: "number", description: "Maximum number of lines to return." },
          },
          ["path"],
        ),
        options: { codemode: true },
        execute: async (raw, context) => {
          await context.progress?.({ status: "reading" })
          const input = raw as ReadInput
          const remote = requireRemote()
          const localPath = resolveToolPath(input.path, state.localCwd)
          const buffer = await readRemoteFile(remote, localPath)
          if (buffer.includes(0)) {
            return { content: `[binary file: ${localPath} (${buffer.length} bytes)]` }
          }
          let text = buffer.toString("utf8")
          if (input.offset !== undefined || input.limit !== undefined) {
            const lines = text.split("\n")
            const start = Math.max(1, input.offset ?? 1) - 1
            const end = input.limit !== undefined ? start + Math.max(0, input.limit) : lines.length
            text = lines.slice(start, end).join("\n")
          }
          return { content: text }
        },
      })

      editor.add({
        name: "write",
        description:
          "Create or overwrite a file on the remote SSH host. Parent directories are created and content is sent over stdin.",
        input: objectInput({ path: PATH, content: { type: "string", description: "File contents." } }, [
          "path",
          "content",
        ]),
        options: { codemode: true },
        execute: async (raw, context) => {
          await context.progress?.({ status: "writing" })
          const input = raw as WriteInput
          const remote = requireRemote()
          const localPath = resolveToolPath(input.path, state.localCwd)
          await writeRemoteFile(remote, localPath, input.content)
          return { content: `Wrote ${localPath} (${Buffer.byteLength(input.content, "utf8")} bytes)` }
        },
      })

      editor.add({
        name: "edit",
        description: "Replace an exact string in a file on the remote SSH host.",
        input: objectInput(
          {
            path: PATH,
            oldString: { type: "string", description: "Exact text to replace." },
            newString: { type: "string", description: "Replacement text." },
            replaceAll: { type: "boolean", description: "Replace every occurrence (default: first only)." },
          },
          ["path", "oldString", "newString"],
        ),
        options: { codemode: true },
        execute: async (raw, context) => {
          await context.progress?.({ status: "editing" })
          const input = raw as EditInput
          const remote = requireRemote()
          const localPath = resolveToolPath(input.path, state.localCwd)
          if (input.oldString === "") throw new Error("oldString must not be empty")
          await accessRemoteForEdit(remote, localPath)
          const original = (await readRemoteFile(remote, localPath)).toString("utf8")
          if (!original.includes(input.oldString)) throw new Error(`oldString not found in ${localPath}`)
          const updated = input.replaceAll
            ? original.split(input.oldString).join(input.newString)
            : original.replace(input.oldString, input.newString)
          await writeRemoteFile(remote, localPath, updated)
          return { content: `Updated ${localPath}` }
        },
      })

      editor.add({
        name: "bash",
        description:
          "Run a bash command on the remote SSH host. When the local escape hatch is enabled, prefix a command with 'local: ' to run it on this machine instead.",
        input: objectInput(
          {
            command: { type: "string", description: "Command to run." },
            cwd: { type: "string", description: "Working directory (mapped to the remote host)." },
            timeout: { type: "number", description: "Timeout in seconds." },
          },
          ["command"],
        ),
        options: { codemode: true },
        execute: async (raw, context) => {
          await context.progress?.({ status: "running" })
          const input = raw as BashInput
          const remote = requireRemote()
          const cwd = input.cwd ? resolveToolPath(input.cwd, state.localCwd) : state.localCwd
          const result = await runBash(remote, input.command, cwd, {
            signal: context.signal,
            timeout: input.timeout,
          })
          const body = result.output.trimEnd() || "(no output)"
          const suffix = result.exitCode === 0 ? "" : `\n[exit ${result.exitCode ?? "null"}]`
          return { content: `${body}${suffix}` }
        },
      })

      editor.add({
        name: "ls",
        description:
          "List a directory on the remote SSH host. Entries are sorted, dotfiles included, directories end with '/'. Paths are local paths.",
        input: objectInput(
          {
            path: { type: "string", description: "Directory to list (default: project directory)." },
            limit: { type: "number", description: "Maximum number of entries (default: 500)." },
          },
          [],
        ),
        options: { codemode: true },
        execute: async (raw, context) => {
          await context.progress?.({ status: "listing" })
          const input = raw as LsInput
          const remote = requireRemote()
          return { content: await listRemote(remote, input, state.localCwd, context.signal) }
        },
      })

      editor.add({
        name: "grep",
        description:
          "Search file contents on the remote SSH host. Uses ripgrep when installed there (gitignore-aware), otherwise grep. Paths in results are local paths.",
        input: objectInput(
          {
            pattern: { type: "string", description: "Pattern (regex unless literal is set)." },
            path: { type: "string", description: "File or directory to search (default: project directory)." },
            glob: { type: "string", description: "Glob filter, e.g. '*.ts'." },
            ignoreCase: { type: "boolean", description: "Case-insensitive search." },
            literal: { type: "boolean", description: "Treat the pattern as a fixed string." },
            context: { type: "number", description: "Context lines around each match." },
            limit: { type: "number", description: "Maximum matching lines (default: 100)." },
          },
          ["pattern"],
        ),
        options: { codemode: true },
        execute: async (raw, context) => {
          await context.progress?.({ status: "searching" })
          const input = raw as GrepInput
          const remote = requireRemote()
          return { content: await grepRemote(remote, input, state.localCwd, context.signal) }
        },
      })

      editor.add({
        name: "find",
        description:
          "Find files by glob on the remote SSH host. Uses fd when installed there, otherwise find. Paths in results are local paths.",
        input: objectInput(
          {
            pattern: { type: "string", description: "Glob pattern, e.g. '*.ts' or 'src/**/*.spec.ts'." },
            path: { type: "string", description: "Directory to search (default: project directory)." },
            limit: { type: "number", description: "Maximum number of results (default: 1000)." },
          },
          ["pattern"],
        ),
        options: { codemode: true },
        execute: async (raw, context) => {
          await context.progress?.({ status: "searching" })
          const input = raw as FindInput
          const remote = requireRemote()
          return { content: await findRemote(remote, input, state.localCwd, context.signal) }
        },
      })
    }

    async function connect(spec: string): Promise<boolean> {
      try {
        const target = parseSshTarget(spec)
        const session = await SshSession.open({
          host: target.host,
          dir: target.dir,
          extraOptions: state.extraOptions.length > 0 ? state.extraOptions : undefined,
          shell: state.shell,
        })
        state.session?.close()
        state.session = session
        state.mapper = createPathMapper(state.localCwd, session.cwd)
        state.error = undefined
        state.lastSpec = spec
        await setTools(true)
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        state.session?.close()
        state.session = null
        state.mapper = null
        state.error = message
        await setTools(false)
        return false
      }
    }

    async function disconnect(): Promise<void> {
      state.session?.close()
      state.session = null
      state.mapper = null
      await setTools(false)
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "ssh",
        description: "Inspect or control the SSH link (status | run <cmd> | local <cmd> | on [target] | off)",
        execute: async ({ sessionID, prompt }) => {
          const [subcommand, ...rest] = (prompt.text ?? "").trim().split(/\s+/)
          const payload = rest.join(" ").trim()

          switch ((subcommand ?? "").toLowerCase()) {
            case "off":
              await disconnect()
              await notify(sessionID, "SSH mode off; tools run locally again")
              return
            case "on": {
              const spec = payload || state.lastSpec
              if (!spec) {
                await notify(sessionID, "Usage: /ssh on user@host[:/remote/dir]")
                return
              }
              const ok = await connect(spec)
              await notify(
                sessionID,
                ok ? `SSH connected.\n${describeSession()}` : `SSH connection failed: ${state.error ?? "unknown error"}`,
              )
              return
            }
            case "run": {
              if (!payload) {
                await notify(sessionID, "Usage: /ssh run <command>")
                return
              }
              if (!state.session) {
                await notify(sessionID, "Not connected. Use /ssh on user@host first.")
                return
              }
              try {
                const output = await state.session.capture(payload, { timeout: 120 })
                await notify(sessionID, output.trim() ? clip(output) : "(no output)")
              } catch (error) {
                await notify(sessionID, error instanceof Error ? error.message : String(error))
              }
              return
            }
            case "local": {
              if (!payload) {
                await notify(sessionID, "Usage: /ssh local <command>")
                return
              }
              try {
                const { exitCode, output } = await runLocalBash(payload, state.localCwd, { timeout: 120 })
                await notify(
                  sessionID,
                  `exit ${exitCode ?? "null"}\n${output.trim() ? clip(output) : "(no output)"}`,
                )
              } catch (error) {
                await notify(sessionID, error instanceof Error ? error.message : String(error))
              }
              return
            }
            default:
              await notify(sessionID, describeSession())
              return
          }
        },
      })
    })

    await ctx.session.hook("context", (event) => {
      const remote = remoteContext()
      if (!remote) return
      const { session, localCwd, allowLocalBash } = remote
      event.system.push({
        type: "text",
        text: [
          `You are working on the remote machine ${session.host}: the read, write, edit, bash, ls, grep and find tools execute there, not on the local machine.`,
          `Remote session: ${session.host} (${session.uname})`,
          `Working directory: ${session.cwd}`,
          `The local directory ${localCwd} is mapped onto the remote working directory, so paths under it are translated for you. Absolute paths outside it (for example /etc/hosts) are used on the remote host as-is.`,
          `File contents, command output and search results all come from ${session.host}. Paths shown by ls, grep and find are local paths, ready to be passed to another tool.`,
          allowLocalBash
            ? `To run a command on the local machine instead, prefix it with "${LOCAL_ESCAPE_PREFIX} ".`
            : "There is no local escape hatch: everything runs on the remote host.",
        ].join("\n"),
      })
    })

    // Connect on load when a target was supplied through plugin options / env.
    const initialSpec = firstString(options.target, options.ssh, options.host, process.env.PI_SSH_TARGET)
    if (initialSpec) await connect(initialSpec)

    return () => {
      state.session?.close()
      state.session = null
      state.mapper = null
      if (toolRegistration) void toolRegistration.dispose().catch(() => {})
    }
  },
})
