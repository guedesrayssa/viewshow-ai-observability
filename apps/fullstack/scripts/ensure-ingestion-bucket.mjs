// Cria ou adota o bucket da ingestão sem usar aws_s3_bucket no Learner Lab.
// A SCP do laboratório nega GetBucketObjectLockConfiguration, chamada que o
// provider faz no refresh do recurso monolítico mesmo sem Object Lock ativo.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function runAws(arguments_) {
  const result = spawnSync("aws", arguments_, {
    encoding: "utf-8",
    shell: false,
  });

  if (result.error) {
    const detail =
      result.error.code === "ENOENT"
        ? "o AWS CLI não está instalado ou não está no PATH"
        : result.error.message;
    throw new Error(`falha ao executar AWS CLI: ${detail}`);
  }

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `AWS CLI terminou com código ${result.status}`);
  }

  return result.stdout.trim();
}

function validateEnvironment(environment) {
  const required = [
    "AWS_REGION",
    "BUCKET_NAME",
    "DEPLOYMENT_ENVIRONMENT",
    "EXPECTED_ACCOUNT_ID",
    "DEPLOYMENT_NAMESPACE",
    "FRONTEND_ORIGIN",
  ];

  for (const name of required) {
    if (!environment[name]) throw new Error(`variável de ambiente ausente: ${name}`);
  }

  const {
    AWS_REGION,
    BUCKET_NAME,
    DEPLOYMENT_ENVIRONMENT,
    EXPECTED_ACCOUNT_ID,
    DEPLOYMENT_NAMESPACE,
    FRONTEND_ORIGIN,
  } = environment;

  if (DEPLOYMENT_ENVIRONMENT !== "learner-lab") {
    throw new Error("o modo compatível de criação de bucket é exclusivo do Learner Lab");
  }

  if (!/^\d{12}$/.test(EXPECTED_ACCOUNT_ID)) {
    throw new Error("EXPECTED_ACCOUNT_ID deve conter exatamente 12 dígitos");
  }

  if (!/^[a-z]{2}(-gov)?-[a-z]+-\d+$/.test(AWS_REGION)) {
    throw new Error("AWS_REGION inválida para criação segura do bucket");
  }

  if (!/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(DEPLOYMENT_NAMESPACE)) {
    throw new Error("DEPLOYMENT_NAMESPACE inválido para criação segura do bucket");
  }

  const safePrefix = `${DEPLOYMENT_NAMESPACE}-ingestion-${EXPECTED_ACCOUNT_ID}-${AWS_REGION}`;
  const isValidBucketName =
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(BUCKET_NAME) &&
    (BUCKET_NAME === safePrefix || BUCKET_NAME.startsWith(`${safePrefix}-`)) &&
    !BUCKET_NAME.includes("..") &&
    !/^\d+\.\d+\.\d+\.\d+$/.test(BUCKET_NAME);

  if (!isValidBucketName) {
    throw new Error(
      "BUCKET_NAME não pertence ao namespace seguro da ingestão nesta conta e região",
    );
  }


  let frontendOrigin;
  try {
    frontendOrigin = new URL(FRONTEND_ORIGIN);
  } catch {
    throw new Error("FRONTEND_ORIGIN deve ser uma origem HTTPS válida");
  }
  if (
    frontendOrigin.protocol !== "https:" ||
    frontendOrigin.origin !== FRONTEND_ORIGIN ||
    frontendOrigin.username ||
    frontendOrigin.password ||
    frontendOrigin.pathname !== "/" ||
    frontendOrigin.search ||
    frontendOrigin.hash ||
    FRONTEND_ORIGIN.includes("*")
  ) {
    throw new Error("FRONTEND_ORIGIN deve ser uma origem HTTPS sem path, query ou wildcard");
  }
}

function normalizeBucketRegion(locationConstraint) {
  const value = locationConstraint.trim();
  if (!value || value === "None" || value === "null") return "us-east-1";
  if (value === "EU") return "eu-west-1";
  return value;
}

export function ensureIngestionBucket(environment = process.env, aws = runAws) {
  validateEnvironment(environment);

  const { AWS_REGION, BUCKET_NAME, EXPECTED_ACCOUNT_ID, FRONTEND_ORIGIN } = environment;
  const activeAccountId = aws([
    "sts",
    "get-caller-identity",
    "--query",
    "Account",
    "--output",
    "text",
  ]);

  if (activeAccountId !== EXPECTED_ACCOUNT_ID) {
    throw new Error(
      `a conta AWS ativa (${activeAccountId}) difere da conta esperada (${EXPECTED_ACCOUNT_ID})`,
    );
  }

  const ownedBucketNames = aws([
    "s3api",
    "list-buckets",
    "--query",
    "Buckets[].Name",
    "--output",
    "text",
  ])
    .split(/\s+/)
    .filter(Boolean);

  const bucketAlreadyOwned = ownedBucketNames.includes(BUCKET_NAME);
  if (!bucketAlreadyOwned) {
    const createArguments = [
      "s3api",
      "create-bucket",
      "--bucket",
      BUCKET_NAME,
      "--region",
      AWS_REGION,
    ];
    if (AWS_REGION !== "us-east-1") {
      createArguments.push(
        "--create-bucket-configuration",
        `LocationConstraint=${AWS_REGION}`,
      );
    }
    aws(createArguments);
  }

  const bucketRegion = normalizeBucketRegion(
    aws([
      "s3api",
      "get-bucket-location",
      "--bucket",
      BUCKET_NAME,
      "--query",
      "LocationConstraint",
      "--output",
      "text",
      "--region",
      AWS_REGION,
    ]),
  );
  if (bucketRegion !== AWS_REGION) {
    throw new Error(
      `a região física do bucket (${bucketRegion}) difere da região esperada (${AWS_REGION})`,
    );
  }


  aws([
    "s3api",
    "put-bucket-cors",
    "--bucket",
    BUCKET_NAME,
    "--cors-configuration",
    JSON.stringify({
      CORSRules: [
        {
          AllowedOrigins: [FRONTEND_ORIGIN],
          AllowedMethods: ["PUT", "HEAD"],
          AllowedHeaders: ["content-type", "x-amz-checksum-sha256"],
          ExposeHeaders: ["ETag", "x-amz-checksum-sha256"],
          MaxAgeSeconds: 900,
        },
      ],
    }),
    "--expected-bucket-owner",
    EXPECTED_ACCOUNT_ID,
    "--region",
    AWS_REGION,
  ]);

  aws([
    "s3api",
    "put-bucket-tagging",
    "--bucket",
    BUCKET_NAME,
    "--tagging",
    "TagSet=[{Key=Projeto,Value=view-show},{Key=ManagedBy,Value=terraform},{Key=Componente,Value=ingestion},{Key=Ambiente,Value=learner-lab}]",
    "--region",
    AWS_REGION,
  ]);
  aws([
    "s3api",
    "wait",
    "bucket-exists",
    "--bucket",
    BUCKET_NAME,
    "--region",
    AWS_REGION,
  ]);

  return bucketAlreadyOwned ? "adopted" : "created";
}

function parseAwsJson(output, description) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${description} retornou JSON inválido`);
  }
}

function assertExpectedBucketTags(environment, aws) {
  const { AWS_REGION, BUCKET_NAME, EXPECTED_ACCOUNT_ID } = environment;
  const response = parseAwsJson(
    aws([
      "s3api",
      "get-bucket-tagging",
      "--bucket",
      BUCKET_NAME,
      "--expected-bucket-owner",
      EXPECTED_ACCOUNT_ID,
      "--region",
      AWS_REGION,
      "--output",
      "json",
    ]),
    "get-bucket-tagging",
  );
  const tags = new Map(
    Array.isArray(response.TagSet)
      ? response.TagSet
          .filter((tag) => typeof tag?.Key === "string" && typeof tag?.Value === "string")
          .map((tag) => [tag.Key, tag.Value])
      : [],
  );
  const expected = {
    Projeto: "view-show",
    ManagedBy: "terraform",
    Componente: "ingestion",
    Ambiente: "learner-lab",
  };
  if (Object.entries(expected).some(([key, value]) => tags.get(key) !== value)) {
    throw new Error("o bucket não possui as tags esperadas da stack View Show");
  }
}

function deleteBucketVersions(environment, aws) {
  const { AWS_REGION, BUCKET_NAME, EXPECTED_ACCOUNT_ID } = environment;
  const response = parseAwsJson(
    aws([
      "s3api",
      "list-object-versions",
      "--bucket",
      BUCKET_NAME,
      "--expected-bucket-owner",
      EXPECTED_ACCOUNT_ID,
      "--region",
      AWS_REGION,
      "--output",
      "json",
    ]),
    "list-object-versions",
  );
  const entries = [...(response.Versions ?? []), ...(response.DeleteMarkers ?? [])];
  const objects = entries.map((entry) => {
    if (typeof entry?.Key !== "string" || typeof entry?.VersionId !== "string") {
      throw new Error("list-object-versions retornou uma versão inválida");
    }
    return { Key: entry.Key, VersionId: entry.VersionId };
  });
  for (let start = 0; start < objects.length; start += 1000) {
    aws([
      "s3api",
      "delete-objects",
      "--bucket",
      BUCKET_NAME,
      "--delete",
      JSON.stringify({ Objects: objects.slice(start, start + 1000), Quiet: true }),
      "--expected-bucket-owner",
      EXPECTED_ACCOUNT_ID,
      "--region",
      AWS_REGION,
      "--output",
      "json",
    ]);
  }
}

function abortMultipartUploads(environment, aws) {
  const { AWS_REGION, BUCKET_NAME, EXPECTED_ACCOUNT_ID } = environment;
  const response = parseAwsJson(
    aws([
      "s3api",
      "list-multipart-uploads",
      "--bucket",
      BUCKET_NAME,
      "--expected-bucket-owner",
      EXPECTED_ACCOUNT_ID,
      "--region",
      AWS_REGION,
      "--output",
      "json",
    ]),
    "list-multipart-uploads",
  );
  for (const upload of response.Uploads ?? []) {
    if (typeof upload?.Key !== "string" || typeof upload?.UploadId !== "string") {
      throw new Error("list-multipart-uploads retornou um upload inválido");
    }
    aws([
      "s3api",
      "abort-multipart-upload",
      "--bucket",
      BUCKET_NAME,
      "--key",
      upload.Key,
      "--upload-id",
      upload.UploadId,
      "--expected-bucket-owner",
      EXPECTED_ACCOUNT_ID,
      "--region",
      AWS_REGION,
    ]);
  }
}

export function destroyIngestionBucket(environment = process.env, aws = runAws) {
  validateEnvironment(environment);
  const { AWS_REGION, BUCKET_NAME, EXPECTED_ACCOUNT_ID } = environment;
  const activeAccountId = aws([
    "sts",
    "get-caller-identity",
    "--query",
    "Account",
    "--output",
    "text",
  ]);
  if (activeAccountId !== EXPECTED_ACCOUNT_ID) {
    throw new Error(
      `a conta AWS ativa (${activeAccountId}) difere da conta esperada (${EXPECTED_ACCOUNT_ID})`,
    );
  }

  assertExpectedBucketTags(environment, aws);
  abortMultipartUploads(environment, aws);
  deleteBucketVersions(environment, aws);
  aws([
    "s3api",
    "delete-bucket",
    "--bucket",
    BUCKET_NAME,
    "--expected-bucket-owner",
    EXPECTED_ACCOUNT_ID,
    "--region",
    AWS_REGION,
  ]);
  aws(["s3api", "wait", "bucket-not-exists", "--bucket", BUCKET_NAME, "--region", AWS_REGION]);
  return "destroyed";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const action = process.env.INGESTION_BUCKET_ACTION ?? "ensure";
    if (action === "destroy") {
      destroyIngestionBucket();
      console.log("bucket de ingestão removido");
    } else if (action === "ensure") {
      const result = ensureIngestionBucket();
      console.log(`bucket de ingestão ${result === "created" ? "criado" : "adotado"}`);
    } else {
      throw new Error("INGESTION_BUCKET_ACTION deve ser ensure ou destroy");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
