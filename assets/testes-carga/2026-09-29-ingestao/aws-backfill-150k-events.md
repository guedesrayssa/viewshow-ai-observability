# Eventos selecionados — backfill AWS de 150 mil registros

Janela UTC: `2026-09-29T23:45:00Z` a `2026-09-30T03:00:00Z`.

| Horário UTC | Sinal | Valor |
| --- | --- | --- |
| 23:49:00 | `ingestion.run.started` | `runId=backfill-095005d410c9ac0589c73f1d41e319125dd1f5d0`, `stage=STARTING` |
| 23:49:00 | `StageDurationMs{stage=STARTING}` | 175 ms |
| 23:49:04 | `StageDurationMs{stage=RESTORING}` | 3.276 ms |
| 23:49:04 | `StageDurationMs{stage=VALIDATING}` | 342 ms |
| 23:59:25 | `StageDurationMs{stage=INGESTING}` | 621.536 ms |
| 00:17:34 | `StageDurationMs{stage=PROJECTING}` | 1.088.407 ms |
| 02:54:49 | ECS `stop-task` | limite controlado excedido; `UserInitiated` |
| 02:56:06 | ECS `STOPPED` | ingestão `exitCode=137`; auxiliares `exitCode=0` |

Consulta consistente do registro durável após a parada:

```json
{
  "runId": "backfill-095005d410c9ac0589c73f1d41e319125dd1f5d0",
  "recordsRead": 150000,
  "recordsWritten": 150000,
  "recordsRejected": 0,
  "stage": "ARCHIVING",
  "updatedAt": "2026-09-30T00:17:34.267475Z"
}
```

Não foram encontrados eventos `ingestion.run.finished`,
`ingestion.run.failed` ou `ingestion.run.partial` para a run. As consultas de
`Runs{status=FAILED}` e `StageFailures{stage=ARCHIVING}` também retornaram zero
datapoints. Isso é uma ausência de estado terminal, não evidência de sucesso ou
taxa de erro igual a zero.
