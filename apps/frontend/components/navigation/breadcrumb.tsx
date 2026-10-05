/**
 * @file breadcrumb.tsx
 * Trilha de volta nas telas internas de uma seção.
 */

import Link from "next/link";
import { Fragment } from "react";

import { ChevronRightIcon } from "@/components/ui/icons";

export type Crumb = { label: string; href?: string };

export function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Trilha de navegação">
      <ol className="flex flex-wrap items-center gap-1.5 text-caption text-ink-muted">
        {items.map((item, index) => {
          const last = index === items.length - 1;

          return (
            <Fragment key={`${item.label}-${index}`}>
              <li>
                {item.href && !last ? (
                  <Link
                    href={item.href}
                    className="focus-ring rounded-field font-medium text-ink-brand hover:underline"
                  >
                    {item.label}
                  </Link>
                ) : (
                  <span aria-current={last ? "page" : undefined} className="font-medium text-ink">
                    {item.label}
                  </span>
                )}
              </li>
              {!last ? (
                <li aria-hidden="true" className="text-ink-subtle">
                  <ChevronRightIcon size={14} />
                </li>
              ) : null}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
