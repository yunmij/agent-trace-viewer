// text.ts — content（string | block[]）→ 纯文本的共享提取器
// claude（toText）与 codex（codexText）各有一份历史实现，行为略有差异，保持原样不合并。

// claude：block 取 .text，回退 .content
export function toText(c: unknown): string {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b === "object" ? ((b as any).text ?? (b as any).content ?? "") : String(b))).join("");
  return String(c);
}

// codex：block 仅取 .text（无 .content 回退）
export function codexText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b === "object" ? ((b as any).text ?? "") : String(b))).join("");
  return String(content);
}
