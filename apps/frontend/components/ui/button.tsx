import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
};

export function Button({ children, icon, className, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        "brand-gradient inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90",
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}
