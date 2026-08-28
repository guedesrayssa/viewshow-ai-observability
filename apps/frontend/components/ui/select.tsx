/**
 * @file select.tsx
 * Seletor de opção única.
 *
 * Usado nas barras de filtro, onde o valor selecionado já funciona como rótulo
 * visível do campo.
 *
 * É um listbox próprio, e não um `<select>` nativo: a lista aberta do nativo é
 * desenhada pelo sistema operacional e não aceita o tipo, o raio, o espaçamento
 * nem as cores do produto — no tema escuro ela chegava a abrir clara. Em troca
 * de escrevê-lo, o teclado e o leitor de tela precisam ser implementados aqui:
 * setas, Home, End, Enter, Espaço, Esc, digitação para pular até a opção, e os
 * papéis `combobox`/`listbox` da WAI-ARIA.
 *
 * A lista é levada para o fim do documento e posicionada em coordenadas de
 * viewport. Sem isso, ela seria cortada pelo `overflow` dos cartões que a
 * contêm.
 */

"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { CheckIcon, ChevronDownIcon } from "@/components/ui/icons";
import { FIELD_SIZE_CLASSES, type FieldSize } from "@/components/ui/input";
import { cn } from "@/lib/cn";

/** Opção oferecida pelo seletor. */
export type SelectOptionItem = {
  value: string;
  label: string;
  /** Texto de apoio, exibido abaixo do rótulo na lista aberta. */
  hint?: string;
  disabled?: boolean;
};

export type SelectProps = {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOptionItem[];
  /** Rótulo acessível. Obrigatório: o campo não tem rótulo visível. */
  "aria-label"?: string;
  fieldSize?: FieldSize;
  /** Ícone exibido à esquerda do valor selecionado. */
  icon?: ReactNode;
  /** Texto exibido quando nenhum valor corresponde às opções. */
  placeholder?: string;
  disabled?: boolean;
  className?: string;
};

/** Espaço entre o campo e a lista aberta, em pixels. */
const GAP = 6;

/** Altura máxima da lista antes de ela rolar. */
const MAX_LIST_HEIGHT = 288;

/** Largura mínima da lista, para que o rótulo respire mesmo em campo curto. */
const MIN_LIST_WIDTH = 208;

/** Distância mínima da lista até a borda da janela. */
const EDGE_GAP = 8;

type Position = { top: number; left: number; width: number; openUp: boolean };

/**
 * Seletor de opção única.
 *
 * @example
 * <Select
 *   aria-label="Período"
 *   value={period}
 *   onValueChange={setPeriod}
 *   options={[{ value: "30", label: "Últimos 30 min" }]}
 * />
 */
export function Select({
  value,
  onValueChange,
  options,
  fieldSize = "sm",
  icon,
  placeholder = "Selecionar",
  disabled = false,
  className,
  ...props
}: SelectProps) {
  const listboxId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typeaheadRef = useRef({ query: "", at: 0 });

  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const [activeIndex, setActiveIndex] = useState(Math.max(0, selectedIndex));

  const selected = options[selectedIndex];

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    // Abrir para cima quando não há espaço embaixo evita que a lista fique
    // presa na borda da janela com duas opções visíveis.
    const openUp = below < MAX_LIST_HEIGHT + GAP && rect.top > below;

    // A lista nunca é mais estreita que o campo, e pode ser mais larga quando o
    // rótulo da opção é longo. Perto da borda direita, ela se alinha pelo fim
    // para não sair da janela.
    const width = Math.max(rect.width, MIN_LIST_WIDTH);
    const left = Math.max(
      EDGE_GAP,
      Math.min(rect.left, window.innerWidth - width - EDGE_GAP),
    );

    setPosition({
      top: openUp ? rect.top - GAP : rect.bottom + GAP,
      left,
      width,
      openUp,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;

    const onScrollOrResize = () => updatePosition();
    // `capture` alcança também a rolagem de contêineres internos.
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);

    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        listRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  /* Mantém a opção ativa visível enquanto se navega pelo teclado. */
  useEffect(() => {
    if (!open) return;

    const node = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    node?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const openList = useCallback(
    (index: number) => {
      if (disabled) return;
      setActiveIndex(Math.max(0, index));
      setOpen(true);
    },
    [disabled],
  );

  const commit = useCallback(
    (index: number) => {
      const option = options[index];
      if (!option || option.disabled) return;

      onValueChange(option.value);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [options, onValueChange],
  );

  /** Próximo índice selecionável na direção pedida. */
  const step = useCallback(
    (from: number, direction: 1 | -1) => {
      const total = options.length;
      for (let offset = 1; offset <= total; offset += 1) {
        const next = (from + direction * offset + total * offset) % total;
        if (!options[next]?.disabled) return next;
      }
      return from;
    },
    [options],
  );

  function onKeyDown(event: React.KeyboardEvent) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) openList(selectedIndex);
        else setActiveIndex((current) => step(current, 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!open) openList(selectedIndex);
        else setActiveIndex((current) => step(current, -1));
        break;
      case "Home":
        if (open) {
          event.preventDefault();
          setActiveIndex(step(options.length - 1, 1));
        }
        break;
      case "End":
        if (open) {
          event.preventDefault();
          setActiveIndex(step(0, -1));
        }
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (open) commit(activeIndex);
        else openList(selectedIndex);
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          setOpen(false);
        }
        break;
      case "Tab":
        setOpen(false);
        break;
      default: {
        // Digitar salta para a opção começada por aquelas letras, como no
        // seletor nativo.
        if (event.key.length !== 1 || event.metaKey || event.ctrlKey) return;

        const now = Date.now();
        const state = typeaheadRef.current;
        state.query = now - state.at > 700 ? event.key : state.query + event.key;
        state.at = now;

        const query = state.query.toLowerCase();
        const found = options.findIndex(
          (option) =>
            !option.disabled && option.label.toLowerCase().startsWith(query),
        );

        if (found >= 0) {
          if (open) setActiveIndex(found);
          else onValueChange(options[found].value);
        }
      }
    }
  }

  const list = useMemo(
    () =>
      position ? (
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={props["aria-label"]}
          aria-activedescendant={`${listboxId}-${activeIndex}`}
          tabIndex={-1}
          className={cn(
            "fixed z-50 overflow-y-auto rounded-card border border-line bg-surface p-1 shadow-raised",
            "animate-rise-sm",
          )}
          style={{
            top: position.top,
            left: position.left,
            minWidth: position.width,
            maxHeight: MAX_LIST_HEIGHT,
            transform: position.openUp ? "translateY(-100%)" : undefined,
          }}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const isActive = index === activeIndex;

            return (
              <li
                key={option.value}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled || undefined}
                onPointerEnter={() => setActiveIndex(index)}
                onClick={() => commit(index)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-field px-2.5 py-2",
                  "text-body-sm transition-colors duration-150",
                  isActive ? "bg-brand-blue-soft text-ink" : "text-ink-muted",
                  isSelected && "font-semibold text-ink",
                  option.disabled && "cursor-not-allowed opacity-50",
                )}
              >
                <span className="flex-1">
                  <span className="block">{option.label}</span>
                  {option.hint ? (
                    <span className="block text-micro text-ink-subtle">
                      {option.hint}
                    </span>
                  ) : null}
                </span>

                {/* O espaço da marca fica reservado sempre: sem isso, o rótulo
                    da opção escolhida saltaria ao ser selecionada. */}
                <span className="w-4 shrink-0 text-ink-brand">
                  {isSelected ? <CheckIcon size={16} /> : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null,
    [position, options, value, activeIndex, listboxId, commit, props],
  );

  return (
    <div className={cn("relative inline-flex", className)}>
      {icon ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-ink-subtle"
        >
          {icon}
        </span>
      ) : null}

      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={props["aria-label"]}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList(selectedIndex))}
        onKeyDown={onKeyDown}
        className={cn(
          "focus-ring flex w-full items-center justify-between gap-2 rounded-field border bg-surface",
          "font-medium text-ink transition-colors duration-150",
          "disabled:cursor-not-allowed disabled:bg-canvas disabled:text-ink-subtle",
          open ? "border-line-brand" : "border-line hover:border-line-strong",
          icon ? "pl-9" : "pl-3",
          "pr-2.5",
          FIELD_SIZE_CLASSES[fieldSize],
        )}
      >
        <span className="truncate">{selected?.label ?? placeholder}</span>
        <ChevronDownIcon
          size={16}
          aria-hidden="true"
          className={cn(
            "shrink-0 text-ink-subtle transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(list, document.body)
        : null}
    </div>
  );
}
