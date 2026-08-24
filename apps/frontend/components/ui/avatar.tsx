/**
 * @file avatar.tsx
 * Retrato da pessoa usuária.
 *
 * Enquanto não há foto, mostra um retrato de espaço reservado: o símbolo de
 * conta sobre o gradiente da marca, do mesmo jeito que a navegação lateral já
 * usa para "Minha conta", só que maior.
 */

import { UserIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";

export type AvatarSize = "md" | "lg";

const SIZE_CLASSES: Record<AvatarSize, string> = {
  md: "h-10 w-10",
  lg: "h-16 w-16",
};

const ICON_SIZE: Record<AvatarSize, number> = {
  md: 20,
  lg: 30,
};

export type AvatarProps = {
  size?: AvatarSize;
  className?: string;
};

/**
 * Retrato de espaço reservado, até a pessoa usuária enviar uma foto.
 *
 * @example
 * <Avatar size="lg" />
 */
export function Avatar({ size = "md", className }: AvatarProps) {
  return (
    <span
      role="img"
      aria-label="Retrato da conta, sem foto definida"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-pill bg-gradient-brand text-ink-inverse",
        SIZE_CLASSES[size],
        className,
      )}
    >
      <UserIcon size={ICON_SIZE[size]} />
    </span>
  );
}
