/**
 * @file input.tsx
 * Campos de formulário do design system.
 *
 * `TextField` é a forma recomendada de escrever um campo: cuida do rótulo, do
 * texto de apoio, da mensagem de erro e das relações de acessibilidade entre
 * eles. `Input`, `Label`, `FieldHint` e `FieldError` ficam expostos para
 * composições fora do padrão.
 */

"use client";

import {
  useId,
  useState,
  type ComponentPropsWithRef,
  type HTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
} from "react";

import { EyeIcon, EyeOffIcon, SearchIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";

/** Altura do campo. `lg` é o padrão das telas de acesso; `sm`, o dos filtros. */
export type FieldSize = "sm" | "md" | "lg";

/**
 * Compartilhada com `Select`, para que campos e seletores fiquem à mesma
 * altura.
 *
 * As alturas não acompanham inteiramente a redução da escala: um campo de
 * filtro pode ser compacto, mas continua sendo alvo de clique e de toque.
 */
export const FIELD_SIZE_CLASSES: Record<FieldSize, string> = {
  sm: "h-11 px-3 text-body-sm",
  md: "h-13 px-4 text-body",
  lg: "h-16 px-5 text-body",
};

/** Rótulo de campo. */
export function Label({
  className,
  ...props
}: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("block text-label text-ink-muted", className)}
      {...props}
    />
  );
}

/** Texto de apoio, exibido abaixo do campo. */
export function FieldHint({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("text-caption text-ink-subtle", className)} {...props} />
  );
}

/**
 * Mensagem de erro do campo.
 *
 * O texto acompanha o ícone e a cor, aplicando a redundância semântica pedida
 * pelas WCAG 2.2: a informação nunca depende só da cor.
 */
export function FieldError({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn("text-caption font-medium text-critical-strong", className)}
      {...props}
    >
      {children}
    </p>
  );
}

export type InputProps = Omit<ComponentPropsWithRef<"input">, "size"> & {
  fieldSize?: FieldSize;
  /** Marca o campo como inválido, aplicando borda e `aria-invalid`. */
  invalid?: boolean;
};

/** Campo de texto sem rótulo. Prefira `TextField`. */
export function Input({
  fieldSize = "lg",
  invalid = false,
  className,
  ...props
}: InputProps) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cn(
        "w-full rounded-field border bg-surface text-ink",
        "placeholder:text-ink-subtle",
        "transition-colors duration-150",
        "disabled:cursor-not-allowed disabled:bg-canvas disabled:text-ink-subtle",
        invalid
          ? "border-critical focus-visible:outline-critical"
          : "border-line hover:border-line-strong",
        FIELD_SIZE_CLASSES[fieldSize],
        className,
      )}
      {...props}
    />
  );
}

/**
 * Campo de busca das barras de filtro, com a lupa embutida à esquerda.
 *
 * @example
 * <SearchInput aria-label="Buscar" placeholder="Buscar" fieldSize="sm" />
 */
export function SearchInput({
  fieldSize = "sm",
  className,
  ...props
}: InputProps) {
  return (
    <div className="relative flex-1">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-subtle"
      >
        <SearchIcon size={18} />
      </span>
      <Input
        type="search"
        fieldSize={fieldSize}
        className={cn("pl-10", className)}
        {...props}
      />
    </div>
  );
}

export type TextFieldProps = InputProps & {
  /** Rótulo visível do campo. */
  label: string;
  /** Texto de apoio exibido enquanto não há erro. */
  hint?: string;
  /** Mensagem de erro. Quando presente, substitui o texto de apoio. */
  error?: string;
  /** Conteúdo exibido à direita do rótulo, como o link de recuperar senha. */
  labelAction?: ReactNode;
};

/**
 * Campo de texto completo, com rótulo, apoio e erro já conectados.
 *
 * @example
 * <TextField label="E-mail" type="email" error={erros.email} />
 */
export function TextField({
  label,
  hint,
  error,
  labelAction,
  id,
  className,
  ...props
}: TextFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={fieldId}>{label}</Label>
        {labelAction}
      </div>

      <Input
        id={fieldId}
        invalid={Boolean(error)}
        // Aponta para a mensagem em vigor, para que o leitor de tela anuncie o
        // erro junto do rótulo em vez de deixá-lo solto na página.
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        className={className}
        {...props}
      />

      {error ? (
        <FieldError id={errorId}>{error}</FieldError>
      ) : hint ? (
        <FieldHint id={hintId}>{hint}</FieldHint>
      ) : null}
    </div>
  );
}

export type PasswordFieldProps = Omit<TextFieldProps, "type">;

/**
 * Campo de senha com alternância entre texto oculto e visível.
 *
 * @example
 * <PasswordField label="Senha" error={erros.password} />
 */
export function PasswordField({
  label,
  hint,
  error,
  labelAction,
  id,
  className,
  ...props
}: PasswordFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const [visible, setVisible] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={fieldId}>{label}</Label>
        {labelAction}
      </div>

      <div className="relative">
        <Input
          id={fieldId}
          type={visible ? "text" : "password"}
          invalid={Boolean(error)}
          aria-describedby={error ? errorId : hint ? hintId : undefined}
          className={cn("pr-14", className)}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          // O botão troca de rótulo junto do estado, para que o leitor de tela
          // anuncie a ação disponível e não o estado atual do campo.
          aria-label={visible ? "Ocultar senha" : "Mostrar senha"}
          aria-pressed={visible}
          className={cn(
            "absolute right-2 top-1/2 -translate-y-1/2",
            "flex h-10 w-10 items-center justify-center rounded-field",
            "text-ink-subtle transition-colors hover:bg-canvas hover:text-ink-muted",
          )}
        >
          {visible ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
        </button>
      </div>

      {error ? (
        <FieldError id={errorId}>{error}</FieldError>
      ) : hint ? (
        <FieldHint id={hintId}>{hint}</FieldHint>
      ) : null}
    </div>
  );
}
