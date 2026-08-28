/**
 * @file inline-script.tsx
 * Script executado durante a leitura do HTML.
 *
 * Serve ao caso em que algo precisa acontecer antes da primeira pintura, como
 * aplicar o tema guardado no navegador. O `type` muda entre servidor e cliente
 * porque o React avisa, em desenvolvimento, quando um componente renderiza uma
 * tag `<script>`: no servidor ela sai executável, e no cliente sai inerte, já
 * que o navegador não reexecuta um script inserido pelo React.
 *
 * @see `app/layout.tsx`, que o usa para resolver o tema.
 */

export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
