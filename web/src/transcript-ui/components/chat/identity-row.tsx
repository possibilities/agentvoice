import {
  AudioLinesIcon,
  BotMessageSquareIcon,
  CircleUserRoundIcon,
  TerminalSquareIcon,
} from "lucide-react";
import { type ReactNode, useId } from "react";

const identities = {
  agent: { icon: BotMessageSquareIcon, name: "Agent" },
  human: { icon: CircleUserRoundIcon, name: "Human" },
  voice: { icon: AudioLinesIcon, name: "Human via Voice" },
  tool: { icon: TerminalSquareIcon, name: "Tool" },
  group: { icon: TerminalSquareIcon, name: "Tool activities" },
};

export function messageTime(createdAt?: string) {
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) return undefined;
  return new Date(createdAt).toLocaleString();
}

/** Identity and actions share fixed rails; the existing primitives own content. */
export function IdentityRow({
  identity,
  createdAt,
  children,
  actions,
}: {
  identity: keyof typeof identities;
  createdAt?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const timeId = useId();
  const time = messageTime(createdAt);
  const { icon: Icon, name } = identities[identity];
  return (
    <div className="identity-row" data-identity={identity}>
      <span className="identity-row__mark">
        <span
          role="img"
          aria-label={name}
          aria-describedby={time ? timeId : undefined}
          title={time}
        >
          <Icon aria-hidden="true" />
        </span>
        {time ? (
          <time id={timeId} dateTime={createdAt} hidden>
            {time}
          </time>
        ) : null}
      </span>
      {children}
      <div className="identity-row__actions">{actions}</div>
    </div>
  );
}
