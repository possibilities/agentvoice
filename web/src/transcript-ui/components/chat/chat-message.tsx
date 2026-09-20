import { ImageIcon } from "lucide-react";
import { memo } from "react";
import { FileChangeAttachments } from "@/components/chat/file-change-attachments";
import { MessageBody } from "@/components/chat/message-body";
import { ToolActivityMessage } from "@/components/chat/tool-activity-message";
import { VoiceMessageModal } from "@/components/chat/voice-message-modal";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { MessageContent, MessageHeader, Message as MessageRow } from "@/components/ui/message";
import { formatClockTime } from "@/lib/relative-time";
import type { Message } from "@/types/message";

function SystemMessage({ message }: { message: Message }) {
  const title =
    message.nativeItemType === "contextCompaction"
      ? "Context compaction"
      : (message.presentation?.title ?? "System");
  const body = message.presentation?.body ?? message.content;
  return (
    <ToolActivityMessage
      message={{
        ...message,
        toolActivity: {
          name: title,
          detail: body,
          state:
            message.status === "working"
              ? "running"
              : message.status === "error"
                ? "error"
                : "complete",
          sections: message.presentation?.details ? [...message.presentation.details] : undefined,
        },
      }}
    />
  );
}

export const ChatMessage = memo(function ChatMessage({ message }: { message: Message }) {
  if (message.nativeItemType === "subAgentActivity") return null;
  if (message.role === "system") return <SystemMessage message={message} />;
  if (message.role === "tool")
    return message.fileChanges ? (
      <FileChangeAttachments message={message} />
    ) : (
      <ToolActivityMessage message={message} />
    );
  const isUser = message.role === "user";
  const isVoiceHandoff = isUser && message.presentation?.title === "Via Voice";
  return (
    <MessageRow align="start" data-role={message.role}>
      <MessageContent>
        <MessageHeader>
          <span className="message-author">
            {isUser ? "Human" : "Agent"}
            {isVoiceHandoff && message.presentation ? (
              <VoiceMessageModal presentation={message.presentation} original={message.content} />
            ) : null}
          </span>
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
            {message.pendingImageCount ? (
              <p className="message-pending-images">
                <ImageIcon aria-hidden="true" />
                {message.pendingImageCount === 1
                  ? "1 image attached"
                  : `${message.pendingImageCount} images attached`}
              </p>
            ) : null}
            <MessageBody message={message} />
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </MessageRow>
  );
});
