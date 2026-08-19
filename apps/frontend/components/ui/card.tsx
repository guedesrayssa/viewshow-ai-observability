import { cn } from "@/lib/utils";

type CardProps = {
  children: React.ReactNode;
  className?: string;
  topAccent?: boolean;
  leftAccentColor?: string;
};

export function Card({
  children,
  className,
  topAccent = false,
  leftAccentColor,
}: CardProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-border bg-surface shadow-sm",
        leftAccentColor && "border-l-4",
        className,
      )}
      style={leftAccentColor ? { borderLeftColor: leftAccentColor } : undefined}
    >
      {topAccent && <div className="brand-gradient h-1.5 w-full" />}
      <div className="p-6">{children}</div>
    </div>
  );
}
