export function nowIso(): string {
  return new Date().toISOString();
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function extractTextDelta(chunk: unknown): string | null {
  if (!chunk || typeof chunk !== "object") return null;
  const record = chunk as Record<string, unknown>;

  if (record.type !== "text-delta") return null;

  if (typeof record.text === "string") return record.text;

  const payload = record.payload;
  if (payload && typeof payload === "object") {
    const payloadRecord = payload as Record<string, unknown>;
    if (typeof payloadRecord.text === "string") return payloadRecord.text;
    if (typeof payloadRecord.delta === "string") return payloadRecord.delta;
  }

  if (typeof record.delta === "string") return record.delta;
  return null;
}

export function toJsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch (error) {
    return {
      type: "unserializable",
      error: errorMessage(error),
    };
  }
}

function extractContentText(content: unknown): string | null {
  if (typeof content === "string") return content;

  if (!Array.isArray(content)) return null;

  const parts = content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      return "";
    })
    .filter((part) => part.length > 0);

  return parts.length > 0 ? parts.join("") : null;
}

export function extractHarnessMessageText(
  event: unknown
): { messageId?: string; text: string } | null {
  if (!event || typeof event !== "object") return null;
  const record = event as Record<string, unknown>;
  if (record.type !== "message_update" && record.type !== "message_end") return null;

  const message = record.message;
  if (!message || typeof message !== "object") return null;
  const messageRecord = message as Record<string, unknown>;

  if (messageRecord.role && messageRecord.role !== "assistant") return null;

  const text = extractContentText(messageRecord.content);
  if (text === null) return null;

  return {
    messageId: typeof messageRecord.id === "string" ? messageRecord.id : undefined,
    text,
  };
}
