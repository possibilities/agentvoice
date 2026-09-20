import { Dialog } from "@base-ui/react/dialog";
import { MicIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { focusComposerAtEnd } from "../../transcript/focus-composer";
import type { MessagePresentation } from "../../types/message";

function ModalSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section className="voice-message-modal__section">
      <h3>{heading}</h3>
      {children}
    </section>
  );
}

export function VoiceMessageModal({
  presentation,
  original,
}: {
  presentation: MessagePresentation;
  original: string;
}) {
  const voiceContext = presentation.details?.find(
    (detail) => detail.label === "Voice context",
  )?.content;
  const additionalDetails = presentation.details?.filter(
    (detail) => detail.label !== "Voice context",
  );

  return (
    <Dialog.Root>
      <Dialog.Trigger
        className="voice-message-modal__trigger"
        aria-label="Open voice message details"
      >
        <MicIcon aria-hidden="true" />
      </Dialog.Trigger>
      <Dialog.Portal className="agentchats-transcript">
        <Dialog.Backdrop className="voice-message-modal__backdrop" />
        <Dialog.Popup className="voice-message-modal__popup">
          <header className="voice-message-modal__header">
            <div>
              <Dialog.Title className="voice-message-modal__title">
                Voice message details
              </Dialog.Title>
            </div>
            <Dialog.Close
              className="voice-message-modal__close"
              aria-label="Close voice message details"
              onClick={(event) =>
                focusComposerAtEnd(event.currentTarget, { allowRestoredFocus: true })
              }
            >
              <XIcon aria-hidden="true" />
            </Dialog.Close>
          </header>
          <div className="voice-message-modal__content">
            <ModalSection heading="Displayed text">
              <p className="voice-message-modal__display-title">{presentation.title}</p>
              <pre>{presentation.body}</pre>
            </ModalSection>
            <ModalSection heading="Voice context">
              {voiceContext?.trim() ? (
                <pre>{voiceContext}</pre>
              ) : (
                <p className="voice-message-modal__missing">
                  No voice context was included in this message.
                </p>
              )}
            </ModalSection>
            {additionalDetails?.map((detail, index) => (
              <ModalSection key={`${index}:${detail.label}`} heading={detail.label}>
                <pre>{detail.content}</pre>
              </ModalSection>
            ))}
            <ModalSection heading="Original message">
              <pre>{original}</pre>
            </ModalSection>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
