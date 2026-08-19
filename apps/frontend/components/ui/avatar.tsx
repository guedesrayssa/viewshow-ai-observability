import { cn } from "@/lib/utils";

type AvatarProps = {
  name: string;
  className?: string;
};

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

export function Avatar({ name, className }: AvatarProps) {
  return (
    <div
      className={cn(
        "brand-gradient flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white",
        className,
      )}
      aria-hidden
    >
      {getInitials(name)}
    </div>
  );
}
