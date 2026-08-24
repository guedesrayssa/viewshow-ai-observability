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

/** Busca. */
export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="10.5" cy="10.5" r="7" />
      <path d="m20.5 20.5-4.4-4.4" />
    </Icon>
  );
}

/** Abertura de seletor e menus. */
export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5 8.5 7 7 7-7" />
    </Icon>
  );
}

/** Fecha um filtro ou aviso. */
export function XIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 6 12 12" />
      <path d="M18 6 6 18" />
    </Icon>
  );
}

/** Visão Geral, na navegação lateral. */
export function HomeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 11.5 12 4l8 7.5" />
      <path d="M6 10v9a1 1 0 0 0 1 1h3.5v-6h3v6H17a1 1 0 0 0 1-1v-9" />
    </Icon>
  );
}

/** Evidências, na navegação lateral. */
export function ListIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 6h11" />
      <path d="M9 12h11" />
      <path d="M9 18h11" />
      <path d="M4 6h.01" />
      <path d="M4 12h.01" />
      <path d="M4 18h.01" />
    </Icon>
  );
}

/** Eventos, na navegação lateral. */
export function ActivityIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 12h4l2-7 4 14 2-7h6" />
    </Icon>
  );
}

/** Monitoramento, na navegação lateral. */
export function MonitorIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M8 20h8" />
      <path d="M12 16.5V20" />
    </Icon>
  );
}

/** Conta da pessoa usuária, no rodapé da navegação lateral. */
export function UserIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20c0-4 3.5-6.5 7.5-6.5s7.5 2.5 7.5 6.5" />
    </Icon>
  );
}

/** Alternância de tema escuro, no topo das telas autenticadas. */
export function MoonIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 14.3A8.5 8.5 0 1 1 9.7 4a7 7 0 0 0 10.3 10.3Z" />
    </Icon>
  );
}

/** Acesso às configurações, no topo das telas autenticadas. */
export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3.25" />
      <path d="M12 3v2.5" />
      <path d="M12 18.5V21" />
      <path d="M3 12h2.5" />
      <path d="M18.5 12H21" />
      <path d="m5.6 5.6 1.8 1.8" />
      <path d="m16.6 16.6 1.8 1.8" />
      <path d="m18.4 5.6-1.8 1.8" />
      <path d="m7.4 16.6-1.8 1.8" />
    </Icon>
  );
}

/** Exportação de dados, no cabeçalho das telas de painel. */
export function ExportIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 15V4" />
      <path d="m8 8 4-4 4 4" />
      <path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
    </Icon>
  );
}
