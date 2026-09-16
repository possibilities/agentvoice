import { memo } from "react";
import { FileChangeMessage } from "@/components/chat/file-change-message";
import { MessageBody } from "@/components/chat/message-body";
import { systemEventCard } from "@/components/chat/system-event-card";
import { ToolActivityMessage } from "@/components/chat/tool-activity-message";
import { VoiceMessageModal } from "@/components/chat/voice-message-modal";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { MessageContent, MessageHeader, Message as MessageRow } from "@/components/ui/message";
import { formatClockTime } from "@/lib/relative-time";
import type { Message } from "@/types/message";

export const ChatMessage = memo(function ChatMessage({ message }: { message: Message }) {
  const SystemEventCard = systemEventCard(message);
  if (SystemEventCard) return <SystemEventCard message={message} />;
  if (message.role === "tool" || message.role === "system") {
    return message.fileChanges ? (
      <FileChangeMessage message={message} />
    ) : (
      <ToolActivityMessage message={message} />
    );
  }
  const isUser = message.role === "user";
  const isVoiceHandoff = isUser && message.presentation?.title === "Via Voice";
  return (
    <MessageRow align="start" data-role={message.role}>
      <MessageContent className={isVoiceHandoff ? "voice-message" : undefined}>
        <MessageHeader>
          <span className="message-author">{isUser ? "Human" : "Agent"}</span>
          {isUser && message.deliveryStatus ? (
            <span className="message-delivery-status" role="status">
              {message.deliveryStatus}
            </span>
          ) : null}
          {message.createdAt ? (
            <time dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>
              {formatClockTime(message.createdAt)}
            </time>
          ) : null}
        </MessageHeader>
        <Bubble align="start" variant={isUser ? "secondary" : "ghost"}>
          <BubbleContent>
            <MessageBody message={message} />
          </BubbleContent>
        </Bubble>
        {isVoiceHandoff && message.presentation ? (
          <VoiceMessageModal presentation={message.presentation} original={message.content} />
        ) : null}
      </MessageContent>
    </MessageRow>
  );
});
