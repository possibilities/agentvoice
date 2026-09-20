import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import type * as React from "react";
import { Button } from "@/components/ui/button";

const attachmentVariants = cva(
  "group/attachment flex w-full max-w-full min-w-0 items-center gap-2 border border-border bg-card text-card-foreground",
  {
    variants: {
      size: {
        default: "min-h-12 px-3 py-2 text-sm",
        sm: "min-h-10 px-2.5 py-1.5 text-xs",
      },
    },
  },
);

function Attachment({
  className,
  state = "done",
  size = "default",
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof attachmentVariants> & {
    state?: "idle" | "processing" | "error" | "done";
  }) {
  return (
    <div
      data-slot="attachment"
      data-state={state}
      data-size={size}
      className={cn(attachmentVariants({ size, className }))}
      {...props}
    />
  );
}

function AttachmentGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="attachment-group"
      className={cn("flex min-w-0 flex-col gap-2", className)}
      {...props}
    />
  );
}

function AttachmentMedia({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="attachment-media"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center bg-muted text-foreground [&_svg:not([class*='size-'])]:size-4 group-data-[state=error]/attachment:text-destructive",
        className,
      )}
      {...props}
    />
  );
}

function AttachmentContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="attachment-content"
      className={cn("max-w-full min-w-0 flex-1 leading-tight", className)}
      {...props}
    />
  );
}

function AttachmentTitle({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="attachment-title"
      className={cn("block max-w-full min-w-0 truncate font-medium", className)}
      {...props}
    />
  );
}

function AttachmentDescription({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="attachment-description"
      className={cn(
        "mt-0.5 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground group-data-[state=error]/attachment:text-destructive",
        className,
      )}
      {...props}
    />
  );
}

function AttachmentActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="attachment-actions"
      className={cn("flex shrink-0 items-center", className)}
      {...props}
    />
  );
}

function AttachmentAction({
  className,
  variant = "ghost",
  size = "icon-xs",
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button
      data-slot="attachment-action"
      variant={variant}
      size={size}
      className={cn(className)}
      {...props}
    />
  );
}

export {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
};
