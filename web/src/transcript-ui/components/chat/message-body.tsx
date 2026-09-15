import { ChevronRightIcon } from "lucide-react";
import type { Message } from "../../types/message";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { MarkdownContent } from "./markdown-content";

function Detail({ label, content }: { label: string; content: string }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="transcript-presentation__trigger">
        <ChevronRightIcon className="tool-disclosure__chevron" aria-hidden="true" />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="transcript-presentation__detail">{content}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function MessageBody({ message }: { message: Message }) {
  const presentation = message.presentation;
  if (!presentation) return <MarkdownContent content={message.content} />;
  const isVoiceHandoff = message.role === "user" && presentation.title === "Via Voice";
  return (
    <div className="transcript-presentation">
      <p className="transcript-presentation__title">{presentation.title}</p>
      <div className="markdown-content transcript-presentation__body">{presentation.body}</div>
      {isVoiceHandoff ? null : (
        <>
          {presentation.details?.map((detail, index) => (
            <Detail key={`${index}:${detail.label}`} {...detail} />
          ))}
          <Detail label="Original message" content={message.content} />
        </>
      )}
    </div>
  );
}
