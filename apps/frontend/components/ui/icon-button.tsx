import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  "aria-label": string;
};

export function IconButton({ className, ...props }: IconButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex h-10 w-10 items-center justify-center rounded-full bg-sidebar text-white transition-opacity hover:opacity-90",
        className,
      )}
      {...props}
    />
  );
}
