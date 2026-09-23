import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { createLlmProvider, type LlmProviderKind } from "./llm-provider-factory.js";
import { DynamoAnalysisStore, SqsAnalysisQueue } from "../worker/aws.js";
import { loadWorkerFiles, parseWorkerDocuments } from "../worker/config.js";
import { AnalysisWorker } from "../worker/orchestrator.js";
import type { ConverseInput, ConverseOutput } from "../adapters/llm/bedrock-provider.js";

const required = (name: string): string => { const value = process.env[name]; if (!value) throw new Error(`Variável obrigatória ausente: ${name}`); return value; };
const positive = (name: string, fallback: number): number => { const raw = process.env[name]; const value = raw === undefined ? fallback : Number(raw); if (!Number.isFinite(value) || value <= 0) throw new Error(`Variável inválida: ${name}`); return value; };

export async function main(): Promise<void> {
  const region = process.env.AWS_REGION ?? "us-east-1";
  const modelLocation=required("ANALYSIS_MODEL_LOCATION"), catalogLocation=required("ANALYSIS_SCOPE_CATALOG_LOCATION");
  const allowUnapproved=process.env.NODE_ENV === "test" && process.env.ALLOW_UNAPPROVED_MODEL === "true";
  const s3=new S3Client({region,maxAttempts:4});
  const readLocation=async(location:string):Promise<string>=>{
    const parsed=new URL(location), body=(await s3.send(new GetObjectCommand({Bucket:parsed.hostname,Key:parsed.pathname.slice(1)}))).Body;
    if(!body) throw new Error(`Objeto vazio: ${location}`); return body.transformToString("utf-8");
  };
  const modelOnS3=modelLocation.startsWith("s3://"), catalogOnS3=catalogLocation.startsWith("s3://");
  if(modelOnS3 !== catalogOnS3) throw new Error("Modelo e catálogo precisam usar o mesmo tipo de localização");
  const documents=modelOnS3 ? [await readLocation(modelLocation),await readLocation(catalogLocation)] as const : null;
  if(documents) {
    const checksum=createHash("sha256").update(documents[0]).digest("hex");
    if(checksum !== required("ANALYSIS_MODEL_SHA256")) throw new Error("Checksum do modelo não confere");
  }
  const loaded=documents ? parseWorkerDocuments(documents[0],documents[1],allowUnapproved) : await loadWorkerFiles(modelLocation,catalogLocation,allowUnapproved);
  const {model,scopes}=loaded;
  const sqsClient = new SQSClient({ region, maxAttempts: 4 });
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region, maxAttempts: 4 }), { marshallOptions: { removeUndefinedValues: true } });
  const provider = required("LLM_PROVIDER") as LlmProviderKind;
  const bedrock = provider === "bedrock" ? new BedrockRuntimeClient({ region, maxAttempts: 4 }) : null;
  const llm = createLlmProvider({ kind: provider, environment: process.env.NODE_ENV ?? "production", modelId: required("LLM_MODEL_ID"),
    maxTokens: positive("LLM_MAX_TOKENS", 2500), temperature: Number(process.env.LLM_TEMPERATURE ?? 0.1), timeoutMs: positive("LLM_TIMEOUT_MS", 120000),
    ...(provider === "ollama" ? { baseUrl: required("OLLAMA_BASE_URL") } : {}),
    ...(bedrock ? { converse: async (input: ConverseInput): Promise<ConverseOutput> => {
      const response = await bedrock.send(new ConverseCommand(input as unknown as ConstructorParameters<typeof ConverseCommand>[0]));
      return response as unknown as ConverseOutput;
    } } : {}) });
  const queue = new SqsAnalysisQueue(sqsClient, required("ANALYSIS_QUEUE_URL"), required("ANALYSIS_DLQ_URL"));
  const store = new DynamoAnalysisStore(documentClient, required("OPERATIONAL_TABLE_NAME"), model.forecast.valueThreshold);
  const telemetry=(event:string,fields:Record<string,unknown>)=>process.stdout.write(`${JSON.stringify({timestamp:new Date().toISOString(),event,...fields})}\n`);
  const worker = new AnalysisWorker({ queue, store, reader: store, model, scopes, llm, telemetry });
  let stopping = false; const active=new Set<Promise<void>>(), concurrency=positive("WORKER_CONCURRENCY",2);
  process.once("SIGTERM", () => { stopping = true; }); process.once("SIGINT", () => { stopping = true; });
  while (!stopping) {
    if(active.size>=concurrency){await Promise.race(active);continue;}
    let deliveries;
    try { deliveries=await queue.receive(); }
    catch(error){telemetry("queue_receive_failed",{message:(error as Error).message});await new Promise(resolve=>setTimeout(resolve,5000));continue;}
    for (const delivery of deliveries) {
      if(active.size>=concurrency) await Promise.race(active);
      const task = worker.process(delivery).finally(() => active.delete(task)); active.add(task);
    }
  }
  await Promise.race([Promise.allSettled([...active]), new Promise(resolve => setTimeout(resolve, positive("SHUTDOWN_TIMEOUT_MS", 240000)))]);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => { process.stderr.write(`${JSON.stringify({ event: "worker_fatal", message: (error as Error).message })}\n`); process.exitCode = 1; });
}
