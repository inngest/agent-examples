import { inngest } from "../inngest/client";
import { runChatAgent } from "./agent";
import type { ChatMessage } from "../inngest/channel";

export const chatFn = inngest.createFunction(
  { id: "chat-agent", triggers: [{ event: "chat/message.sent" }] },
  async ({ event, step }) => {
    const { sessionId, messages } = event.data as { sessionId: string; messages: ChatMessage[] };
    return runChatAgent(step, sessionId, messages);
  },
);
