// Historical logs and undelivered scheduler events are retained during migration.
removed {
  from = aws_cloudwatch_log_group.api
  lifecycle { destroy = false }
}
removed {
  from = aws_cloudwatch_log_group.ingestion_backfill
  lifecycle { destroy = false }
}
removed {
  from = aws_cloudwatch_log_group.ingestion_sync
  lifecycle { destroy = false }
}
removed {
  from = aws_cloudwatch_log_group.ingestion_incremental_export
  lifecycle { destroy = false }
}
removed {
  from = aws_cloudwatch_log_group.ingestion_incremental_ingest
  lifecycle { destroy = false }
}
removed {
  from = aws_cloudwatch_log_group.analysis_worker
  lifecycle { destroy = false }
}
removed {
  from = aws_sqs_queue.ingestion_scheduler_dlq
  lifecycle { destroy = false }
}
