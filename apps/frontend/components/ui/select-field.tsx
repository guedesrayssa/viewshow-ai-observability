import { ChevronDown } from "lucide-react";
import type { SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import type { SelectOption } from "@/lib/dashboard-data";

type SelectFieldProps = SelectHTMLAttributes<HTMLSelectElement> & {
  options: SelectOption[];
  "aria-label": string;
};

export function SelectField({
  options,
  className,
  ...props
}: SelectFieldProps) {
  return (
    <div className={cn("relative", className)}>
      <select
        className="w-full appearance-none rounded-xl border border-border bg-surface py-2.5 pr-9 pl-4 text-sm font-medium text-ink focus:border-accent focus:outline-none"
        {...props}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-ink-muted"
        aria-hidden
      />
    </div>
  );
}
