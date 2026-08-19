import { Search } from "lucide-react";
import type { InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type SearchInputProps = InputHTMLAttributes<HTMLInputElement>;

export function SearchInput({ className, ...props }: SearchInputProps) {
  return (
    <div className={cn("relative flex-1", className)}>
      <Search
        className="pointer-events-none absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2 text-ink-muted"
        aria-hidden
      />
      <input
        type="search"
        className="w-full rounded-xl border border-border bg-surface py-2.5 pr-4 pl-11 text-sm text-ink placeholder:text-ink-muted focus:border-accent focus:outline-none"
        {...props}
      />
    </div>
  );
}
