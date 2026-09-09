# Agentic layer — not implemented

Ownership: futuro time da camada agêntica.

O código agêntico legado em `apps/backend/api/src/agent`, `orchestrator` e
serviços Bedrock/ML foi identificado e permanece congelado, sem mudança
semântica, fora do build e do runtime TypeScript.

A integração futura ocorre pelos ports consumidores `AgenticDiagnosisPort` e
`ReviewFeedbackPort`. Esta entrega não contém agente novo, prompt, algoritmo,
execução Bedrock nem servidor fake. O Incident Service apenas lê diagnósticos
persistidos e declara `AGENTIC_RESULT_UNAVAILABLE` quando não existem.
