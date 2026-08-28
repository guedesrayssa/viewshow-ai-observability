/**
 * @file avatar.tsx
 * Retrato da pessoa usuária.
 *
 * Mostra a foto do perfil quando existe uma. Enquanto não existe, mostra as
 * iniciais do nome sobre o gradiente da marca — mais útil do que um símbolo
 * genérico de conta, porque já identifica quem está na sessão.
 */

"use client";

import { useAccount } from "@/components/account/account-provider";
import { cn } from "@/lib/cn";

export type AvatarSize = "sm" | "md" | "lg";

const SIZE_CLASSES: Record<AvatarSize, string> = {
  sm: "h-8 w-8 text-caption",
  md: "h-10 w-10 text-body-sm",
  lg: "h-16 w-16 text-h3",
};

/** Duas iniciais bastam: nome e último sobrenome. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();

  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export type AvatarProps = {
  size?: AvatarSize;
  className?: string;
};

/**
 * Retrato da conta em sessão.
 *
 * @example
 * <Avatar size="lg" />
 */
export function Avatar({ size = "md", className }: AvatarProps) {
  const { profile } = useAccount();

  return (
    <span
      role="img"
      aria-label={
        profile.photo
          ? `Foto de ${profile.name}`
          : `Retrato de ${profile.name}, sem foto definida`
      }
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-pill",
        "bg-gradient-brand font-semibold text-ink-inverse",
        SIZE_CLASSES[size],
        className,
      )}
    >
      {profile.photo ? (
        // A foto é um data URL guardado no navegador, e não um arquivo servido:
        // `next/image` não teria o que otimizar aqui.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={profile.photo} alt="" className="h-full w-full object-cover" />
      ) : (
        initialsOf(profile.name)
      )}
    </span>
  );
}
