# archer

Pipeline secuencial de agentes [OpenCode](https://opencode.ai) para implementar features sobre un repo Flutter. Recibe un PRD, ejecuta 5 agentes en cadena y deja un commit por fase.

Archer esta escrito en Bun + TypeScript y usa `@opencode-ai/sdk` para controlar OpenCode. El SDK arranca/controla el server de OpenCode; Archer ya no llama manualmente a `opencode run` ni parsea stdout.

## El Pipeline

```
PRD ──► implementer ──► pattern-auditor ──► security-auditor ──► design-polisher ──► test-engineer
                │              │                    │                    │                  │
                └──────────────┴────────────────────┴────────────────────┴──────────────────┘
                                          commit por fase
```

| Fase | Modelo | Qué hace |
|---|---|---|
| `implementer` | `claude-opus-4-7` | Implementa la feature respetando patrones del repo |
| `patterns` | `claude-opus-4-7` | Refactor sin cambiar comportamiento, alinea con el resto del código |
| `security` | `claude-sonnet-4-6` | Audita y arregla problemas de seguridad |
| `design` | `claude-sonnet-4-6` | Pule UI siguiendo el design system del repo |
| `tests` | `claude-sonnet-4-6` | Unit/widget tests verdes + flows Maestro |

## Requisitos

- Bun 1.0+
- `opencode` instalado y autenticado (`opencode auth login`)
- `git`

## Instalación

```bash
git clone <este-repo> archer
cd archer
bun install
make install
```

Eso deja `archer` en `~/.local/bin/archer`. Asegúrate de que está en tu `PATH`.

## Uso

Desde la raíz del repo target, idealmente en una rama de trabajo:

```bash
# prompt inline
archer "Añade pantalla de onboarding con 3 pasos y persistencia local del progreso"

# prompt desde archivo
archer --prompt-file prd.md

# adjuntar archivos o directorios a todas las fases
archer --prompt-file prd.md --file lib/features/onboarding --file test/onboarding_test.dart

# solo una fase
archer --prompt-file prd.md --only implementer

# saltar fases
archer --prompt-file prd.md --skip security,design

# forzar un modelo distinto para todas las fases
archer --prompt-file prd.md --model anthropic/claude-sonnet-4-6

# retomar un run que falló
archer --resume 20260519-103045-x7q2

# preservar el run dir tras terminar
archer --prompt-file prd.md --keep-run-dir

# cambiar la rama base usada para calcular diffs entre fases
archer --prompt-file prd.md --base develop

# incluir cambios locales existentes en el primer commit del pipeline
archer --prompt-file prd.md --include-dirty --max-attempts 1
```

## Adjuntos Eficientes

`--file` es repetible y acepta archivos o directorios. Las rutas relativas se resuelven contra el repo target.

Archer no pega esos contenidos en el prompt. Los envia al SDK como `FilePartInput` con URL `file://`, igual que el `--file` de OpenCode. Lo mismo hace internamente con `prd.md`, reports previos y diffs de fase.

## Anatomía De Un Run

Cada invocación crea `~/.archer/runs/<run-id>/`:

```
~/.archer/runs/20260519-103045-x7q2/
├── prd.md
├── reports/
│   ├── implementer.md
│   ├── patterns.md
│   ├── security.md
│   ├── design.md
│   └── tests.md
├── diffs/
│   ├── patterns.pre.diff
│   ├── security.pre.diff
│   ├── design.pre.diff
│   └── tests.pre.diff
├── logs/
│   ├── implementer.1.json
│   └── ...
└── SUMMARY.md
```

El run dir se borra al terminar correctamente salvo `--keep-run-dir`. Si falla, se preserva para inspeccionar reports, diffs y logs.

El repo target solo ve commits con prefijo `archer(<fase>): ...`, hechos en la rama actual. Ningún archivo del CLI queda en el proyecto.

## Desarrollo

```bash
bun install
bun run typecheck
bun test
bun run build
```

## Estructura

```
archer/
├── src/
│   ├── main.ts          # entrypoint
│   ├── cli.ts           # parseo de flags
│   ├── runner.ts        # orquestación del pipeline
│   ├── opencode.ts      # arranque/control via SDK
│   ├── agents.ts        # prompts y config inline de agentes
│   ├── attachments.ts   # FilePartInput para --file y adjuntos internos
│   ├── git.ts           # diff y commit
│   ├── workspace.ts     # run dir
│   └── phases.ts        # definicion declarativa de fases
├── test/                # tests unitarios de CLI/orquestación
├── package.json
├── tsconfig.json
└── Makefile
```
