/**
 * @file icons.tsx
 * Conjunto mínimo de ícones do design system.
 *
 * São SVGs inline, herdando cor por `currentColor` e tamanho pela prop `size`,
 * para não depender de uma biblioteca externa nem de requisições adicionais.
 * Ícones decorativos recebem `aria-hidden`; quem precisar de rótulo deve
 * declará-lo no elemento que envolve o ícone.
 */

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & {
  /** Lado do ícone em pixels. */
  size?: number;
};

function Icon({ size = 20, children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

/** Indicador de carregamento. A animação para quando o sistema pede menos movimento. */
export function SpinnerIcon({ size = 20, ...props }: IconProps) {
  return (
    <Icon size={size} {...props} className={props.className}>
      <circle cx="12" cy="12" r="9" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9">
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="0.8s"
          repeatCount="indefinite"
        />
      </path>
    </Icon>
  );
}

/** Senha visível. */
export function EyeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

/** Senha oculta. */
export function EyeOffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 3l18 18" />
      <path d="M10.6 6.1A9.6 9.6 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3.2 3.9" />
      <path d="M6.3 8.1A17 17 0 0 0 2.5 12S6 18 12 18a9.7 9.7 0 0 0 3.4-.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </Icon>
  );
}

/** Losango da marca corporativa, usado na entrada por SSO. */
export function DiamondIcon({ size = 20, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d="M12 3.5 20.5 12 12 20.5 3.5 12z" />
    </svg>
  );
}

/** Alerta de severidade. */
export function AlertIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20.2h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4.5" />
      <path d="M12 17h.01" />
    </Icon>
  );
}

/** Confirmação. */
export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4.5 12.5 5 5 10-11" />
    </Icon>
  );
}

/** Informação de apoio. */
export function InfoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </Icon>
  );
}
