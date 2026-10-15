export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

const PER_MESSAGE_OVERHEAD = 8;
const PER_REQUEST_OVERHEAD = 16;

/**
 * Conservative upper bound on prompt tokens. The pinned models use byte-level BPE, where
 * every token covers at least one UTF-8 byte, so a prompt never has more content tokens
 * than bytes; chat-template special tokens are covered by fixed per-message and
 * per-request allowances. This over-counts real usage; it is not an exact token count.
 */
export function conservativeInputTokens(messages: readonly ChatMessage[]): number {
  let total = PER_REQUEST_OVERHEAD;
  for (const m of messages) total += Buffer.byteLength(m.content, "utf8") + PER_MESSAGE_OVERHEAD;
  return total;
}
