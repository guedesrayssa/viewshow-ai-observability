# Documentação do frontend do View Show

Aplicação web do View Show — a plataforma de telemetria de frontend do Globoplay
que diagnostica falhas de reprodução em minutos. Construída com **Next.js 16
(App Router)**, **React 19**, **TypeScript** e **Tailwind CSS v4**.

Este documento reúne toda a documentação do frontend. O guia visual detalhado
(tokens, componentes, contraste) continua em
[`docs/design-system.md`](./docs/design-system.md), e a versão navegável dele, em
`/design-system`.

## Sumário

1. [Início rápido](#1-início-rápido)

---

## 1. Início rápido

```bash
cd apps/frontend
npm install
npm run dev      # http://localhost:3000
```

Sem `.env.local`, a aplicação sobe em **modo de exemplo**: o login abre uma
sessão de demonstração e as telas leem o conjunto de exemplo, dizendo isso em
texto (`DataStatus`). É suficiente para desenvolver a interface inteira sem
backend.

Para apontar para uma API:

```bash
cp .env.example .env.local
# ajuste NEXT_PUBLIC_API_BASE_URL
```

| Script | O que faz |
| --- | --- |
| `npm run dev` | Servidor de desenvolvimento (`next dev`). |
| `npm run build` | Build de produção (`next build`). |
| `npm run start` | Sobe o build de produção (`next start`). |
| `npm run lint` | ESLint (`eslint`). |

Pré-requisitos: **Node.js 20+** e **npm** (há `package-lock.json`). Não há suíte
de testes configurada no pacote hoje.

### Três regras que valem para qualquer tela nova

1. **Nada de cor literal fora de `app/globals.css`.** Use os tokens semânticos
   (`bg-surface`, `text-ink-muted`, `border-line`, `rounded-card`).
2. **Nada de elemento nativo estilizado à mão.** Botões, campos, cartões, selos e
   avisos vêm de `components/ui`. Se falta uma variante, ela é acrescentada ao
   componente, não improvisada na tela.
3. **Todo número passa pela camada de dados** e chega pelo `useResource`, com os
   quatro estados desenhados (esperando, com dado, atualizando, sem leitura).

---

