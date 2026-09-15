import type { Message } from "@/types/message";

export interface Thread {
  id: string;
  sessionId: string;
  title: string;
  messages: Message[];
}
