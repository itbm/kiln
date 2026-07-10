export interface SlashCommand {
  name: string
  /** hint shown after the name, e.g. "[focus]" */
  args?: string
  description: string
  /** needs an existing chat with messages */
  needsChat: boolean
  /** command is handled inside the composer itself */
  local?: boolean
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "compact",
    args: "[focus]",
    description: "Summarise older messages to free up context",
    needsChat: true,
  },
  {
    name: "clear",
    description: "Start fresh context (messages stay visible)",
    needsChat: true,
  },
  {
    name: "title",
    args: "[text]",
    description: "Rename the chat, or regenerate the title",
    needsChat: true,
  },
  {
    name: "model",
    description: "Open the model picker",
    needsChat: false,
    local: true,
  },
  {
    name: "effort",
    args: "auto|low|medium|high",
    description: "Set reasoning effort",
    needsChat: false,
    local: true,
  },
  {
    name: "export",
    description: "Download this chat as JSON",
    needsChat: true,
  },
  {
    name: "help",
    description: "List available commands",
    needsChat: false,
  },
]

export function parseSlashCommand(
  text: string,
): { name: string; arg?: string } | null {
  const m = /^\/([a-z]+)(?:\s+([\s\S]+))?$/i.exec(text.trim())
  if (!m) return null
  return { name: m[1].toLowerCase(), arg: m[2]?.trim() || undefined }
}

export function commandHelpText(): string {
  return SLASH_COMMANDS.map(
    (c) => `/${c.name}${c.args ? ` ${c.args}` : ""} — ${c.description}`,
  ).join("\n")
}
