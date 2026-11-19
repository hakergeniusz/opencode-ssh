/**
 * POSIX shell quoting for the command strings sent over SSH.
 *
 * `ssh host cmd arg` concatenates its arguments with spaces and lets the remote
 * login shell parse them, so every interpolated value has to be quoted here.
 * JSON.stringify is not enough: double quotes still expand `$`, backticks and
 * backslashes. Ported from pi-ssh unchanged (no pi runtime dependency).
 */

/** Quote a single value for safe interpolation into a remote POSIX shell command. */
export function shellQuote(value: string): string {
  if (value === "") return "''"
  // Fast path: only characters that need no quoting at all.
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Quote every argument and join them with spaces. */
export function shellJoin(values: readonly string[]): string {
  return values.map(shellQuote).join(" ")
}

/** Shell used for remote commands: bash by default, overridable with PI_SSH_SHELL. */
export const DEFAULT_REMOTE_SHELL = "bash"

export function resolveRemoteShell(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_SSH_SHELL?.trim()
  return configured ? configured : DEFAULT_REMOTE_SHELL
}

/**
 * Run `script` under `shell` instead of the remote login shell. `exec` keeps the
 * shell's pid and process group so the abort kill still addresses the right process.
 */
export function shellCommand(script: string, shell: string = DEFAULT_REMOTE_SHELL): string {
  return `exec ${shellQuote(shell)} -c ${shellQuote(script)}`
}

/**
 * Build a remote `cd` command. A tilde only expands when unquoted, so the
 * `~` / `~user` prefix stays bare and only the remainder is quoted.
 */
export function cdCommand(dir: string): string {
  const match = /^(~[A-Za-z0-9._-]*)(\/(.*))?$/.exec(dir)
  if (!match) return `cd ${shellQuote(dir)}`
  const prefix = match[1]!
  const rest = match[3]
  return rest ? `cd ${prefix}/${shellQuote(rest)}` : `cd ${prefix}`
}

/**
 * Split a user-supplied option string into argv entries. Understands single and
 * double quotes and backslash escapes, enough for `PI_SSH_OPTIONS="-p 2222 -i key"`.
 */
export function splitOptionString(raw: string): string[] {
  const out: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  let started = false

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i] ?? ""
    if (quote === "'") {
      if (char === "'") quote = undefined
      else current += char
      continue
    }
    if (quote === '"') {
      if (char === "\\" && i + 1 < raw.length && ['"', "\\", "$", "`"].includes(raw[i + 1]!)) {
        current += raw[i + 1] ?? ""
        i++
      } else if (char === '"') {
        quote = undefined
      } else {
        current += char
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (char === "\\" && i + 1 < raw.length) {
      current += raw[i + 1] ?? ""
      i++
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (current.length > 0 || started) {
        out.push(current)
        current = ""
        started = false
      }
      continue
    }
    current += char
    started = true
  }

  if (quote) throw new Error("Unbalanced quote in SSH options")
  if (current.length > 0 || started) out.push(current)
  return out
}
