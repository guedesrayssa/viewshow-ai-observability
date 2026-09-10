# Agentic layer — not implemented

Ownership: futuro time da camada agêntica.

O código agêntico legado foi removido do runtime. Este diretório registra apenas
o limite reservado para a implementação futura do Worker de Análise definido
em `artefatos/arquitetura/analise-e-ia.md`.

A integração futura ocorre pelos ports consumidores `AgenticDiagnosisPort` e
`ReviewFeedbackPort`. Esta entrega não contém agente novo, prompt, algoritmo,
execução Bedrock nem servidor fake. O módulo `incidents` da API apenas lê
diagnósticos persistidos e declara `AGENTIC_RESULT_UNAVAILABLE` quando não
existem.
