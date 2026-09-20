import { ImageIcon } from "lucide-react";
import { memo } from "react";
import { FileChangeAttachments } from "@/components/chat/file-change-attachments";
import { MessageBody } from "@/components/chat/message-body";
import { ToolActivityMessage } from "@/components/chat/tool-activity-message";
import { VoiceMessageModal } from "@/components/chat/voice-message-modal";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { MessageContent, Message as MessageRow } from "@/components/ui/message";
import type { Message } from "@/types/message";
import { IdentityRow } from "./identity-row";

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
      <IdentityRow
        identity={isVoiceHandoff ? "voice" : isUser ? "human" : "agent"}
        createdAt={message.createdAt}
        actions={
          isVoiceHandoff && message.presentation ? (
            <VoiceMessageModal
              presentation={message.presentation}
              original={message.content}
              createdAt={message.createdAt}
            />
          ) : undefined
        }
      >
        <MessageContent>
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
          {isUser && message.deliveryStatus ? (
            <span className="message-delivery-status" role="status">
              {message.deliveryStatus}
            </span>
          ) : null}
        </MessageContent>
      </IdentityRow>
    </MessageRow>
  );
});
