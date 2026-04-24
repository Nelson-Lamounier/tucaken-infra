# Tucaken — Full Architecture Migration Plan

> **Scope**: Lambda/Step Functions/DynamoDB → Kubernetes-native  
> **Platform**: `cdk-monitoring` SharedVpc, `kubernetes-platform` charts  
> **Date**: April 2026

---

## Table of Contents

1. [Architecture Decision Summary](#1-architecture-decision-summary)
2. [What Stays — Legitimate Lambda / AWS Managed](#2-what-stays)
3. [What Migrates — Full Mapping](#3-what-migrates)
4. [Database Consolidation — DynamoDB → RDS PostgreSQL](#4-database-consolidation)
5. [Phase 1 — Platform RDS in cdk-monitoring](#5-phase-1--platform-rds)
6. [Phase 2 — Content Migration DynamoDB → PostgreSQL](#6-phase-2--content-migration)
7. [Phase 3 — Ingestion Pipeline → Kubernetes Job](#7-phase-3--ingestion-pipeline)
8. [Phase 4 — AI Pipelines → Kubernetes Jobs + SSE](#8-phase-4--ai-pipelines)
9. [Phase 5 — Public API + DynamoDB Decommission](#9-phase-5--cleanup)
10. [Phase 6 — Self-Healing Agent — Kubernetes Coverage Extension](#10-phase-6--self-healing-extension)
11. [Full Schema Reference](#11-full-schema-reference)
12. [CDK Stack Disposition](#12-cdk-stack-disposition)
13. [Connection Pooling — PgBouncer](#13-pgbouncer)

---

## 1. Architecture Decision Summary

### The Core Principle Applied Throughout

> **If a constraint drove an architectural decision, verify that constraint exists in Kubernetes before porting the decision.**

Every Lambda chain, Step Functions state machine, and DynamoDB table in the current system was built to work around one of three constraints:

| Original Constraint | Where it applied | Does it exist in K8s? |
|---|---|---|
| Lambda VPC = no internet without NAT ($32/mo) | Ingestion 3-Lambda chain, pipeline Lambdas | **No** — pods inherit node routing |
| Lambda cold start between steps = S3 handoff | S3 staging bucket between Fetcher → Worker | **No** — same process, in-memory |
| Step Functions = "how to chain Lambda calls" | Article, Strategist, Coaching pipelines | **No** — sequential `await` in one pod |
| DynamoDB = no VPC needed for admin data | Articles, job_applications, config | **No** — RDS is already running 24/7 |

**Exception:** The self-healing agent has a genuine reason to live outside Kubernetes. If K8s is unhealthy enough to fire an alert, a pod inside K8s may not be schedulable. Lambda is architecturally correct here, not a workaround.

---

### Mental Model: Lambda vs Pod Decision Tree

```
Does the workload need to run OUTSIDE Kubernetes because K8s itself might be the failure?
  ├── YES → Lambda (self-healing agent, alert bridge)
  └── NO  →
       Is it an AWS-managed service where Lambda IS the invocation interface?
         ├── YES → Lambda (Bedrock Agent, KB sync)
         └── NO  →
              Is it user-facing with streamable output < 30 seconds?
                ├── YES → SSE streaming from API pod
                └── NO  →
                     Is it a background task > 30 seconds?
                       ├── YES → Kubernetes Job
                       └── NO  → Deployment (always-on service)
```

---

## 2. What Stays

These components have genuine reasons to remain as Lambda / AWS-managed services.

| Component | Reason It Stays |
|---|---|
| **BedrockAgentStack** (Agent + Guardrail) | AWS managed Bedrock — Lambda is the invocation model. Cannot be replaced by a pod. |
| **BedrockKbStack** (Pinecone KB) | AWS manages the data source sync. No code to migrate. |
| **BedrockApiStack** (API GW + Lambda proxy) | Thin proxy to Bedrock Agent. Acceptable as-is. Optional future: migrate to admin-api pod route. |
| **Self-healing agent Lambda** | Runs outside K8s by design. CloudWatch Alarms fire from AWS infrastructure at arbitrary times. K8s cannot receive this if it's the failing thing. |
| **AgentCore Gateway + 5 existing MCP tool Lambdas** | AWS-native MCP infrastructure. Tools call SSM, CloudWatch, EC2 SDK — no VPC constraint. |
| **DynamoDB dedup table** (self-healing) | TTL-based point-lookup deduplication — exactly the use case DynamoDB was designed for. |
| **DynamoDB outcomes table** (self-healing) | Append-only event log keyed by `executionId`. Not relational. Correct tool. |
| **Step Functions bootstrap orchestrator** (cdk-monitoring) | Genuine long-running wait states for SSM execution (~5-10 min). Handles control-plane node recovery where kubeadm etcd membership requires deliberate steps. Worker nodes are now handled by Cluster Autoscaler — see Phase 6. |

---

## 3. What Migrates — Full Mapping

```
ai-applications BEFORE                    AFTER
──────────────────────────────────────────────────────────────
RdsPgVectorStack              →  PlatformRdsStack (cdk-monitoring)
  Isolated VPC                →  SharedVpc (already exists)
  SM Interface Endpoint $14   →  ESO syncs credentials (ESO already deployed)
  Bedrock Interface Endpoint  →  Optional (pods reach public endpoint via IRSA)
  Bootstrap Lambda            →  K8s Job (ArgoCD PostSync hook)
  API Gateway                 →  Traefik IngressRoute (already running)

IngestionStack                →  kubernetes-platform/charts/ingestion
  Trigger Lambda              →  admin-api route: POST /ingestion/trigger
  Fetcher Lambda  ─┐          →  single ingestion-worker Job pod
  Worker Lambda   ─┘          →  (ESO manifests already exist in chart)
  S3 staging bucket           →  eliminated (no inter-Lambda handoff needed)

PipelineStack                 →  kubernetes-platform/charts/article-pipeline
  Research Lambda ─┐
  Writer Lambda   ─┤          →  article-worker Job pod (linear process)
  QA Lambda       ─┤
  Publish Lambda  ─┘
  SFN state machine           →  eliminated
  S3 event trigger            →  eliminated (admin clicks "Run Pipeline")
  API Gateway trigger         →  admin-api route

StrategistPipelineStack       →  kubernetes-platform/charts/strategist
  Research Lambda  ─┐
  Strategist Lambda─┤         →  strategist-worker Job pod (linear process)
  ResumeBuilder   ─┤
  Persist Lambda  ─┘
  CoachLoader Lambda─┐        →  SSE route in admin-api pod
  Coach Lambda      ─┘           (3 parallel DB reads + Bedrock stream)
  SFN state machines          →  eliminated

PublicApiStack                →  pod already running in kubernetes-platform
  (delete CDK only)

AiContentStack                →  articles table in Platform RDS
  DynamoDB articles table     →  PostgreSQL (Phase 2 migration)

StrategistDataStack           →  career tables in Platform RDS
  DynamoDB job_applications   →  PostgreSQL (Phase 2 migration)
  DynamoDB resumes            →  PostgreSQL (Phase 2 migration)
```

---

## 4. Database Consolidation

### Why One RDS, Not Two

The RdsPgVectorStack RDS instance was created in isolation to avoid NAT Gateway costs for the Worker Lambda. That constraint is gone in Kubernetes. `pgvector` is a PostgreSQL extension (`CREATE EXTENSION vector;`), not a separate engine. There is no architectural justification for a separate RDS instance.

**Cost recovered by consolidation:**

| Resource | Monthly Cost |
|---|---|
| SM Interface Endpoint (2 AZs) | ~$14 |
| Bedrock Runtime Endpoint (2 AZs) | ~$14 |
| API Gateway | ~$3 |
| Operational complexity | ∞ |
| **Total recovered** | **~$31/month** |

### Unified Schema — Four Domains

```
Platform RDS PostgreSQL 16 + pgvector
├── knowledge    document_embeddings, repo_sync_state, repositories
├── content      articles (migrated from DynamoDB)
├── career       job_applications, resumes, interview_stages, coaching_content
└── platform     users, oauth_connections, api_keys, app_config, ingestion_audit_log
```

The full schema DDL is in [Section 11](#11-full-schema-reference).

---

## 5. Phase 1 — Platform RDS

**Goal:** Create the single PostgreSQL instance in `cdk-monitoring` SharedVpc that all subsequent phases depend on.

**Estimated time:** 1 day

### Pre-flight Gaps (verified against codebase before implementation)

| Gap | What the doc assumed | Reality |
|---|---|---|
| Subnet type | `PRIVATE_WITH_EGRESS` | SharedVpc has **PUBLIC subnets only** (`natGateways: 0`). Use `SubnetType.PUBLIC` + `publiclyAccessible: false`. |
| Secret IAM scope | Implicit — existing grants cover it | `secretsManagerPathPattern: nextjs-development/*` does NOT cover `k8s-development/platform-rds/*`. AppIamStack needs a new `additionalSecretArns` grant. |
| SSM path prefix | `/${props.namePrefix}/platform-rds/` | cdk-monitoring k8s project uses `/k8s/${environment}/`. Use `/k8s/development/platform-rds/`. |
| VPC lookup name | `props.vpcName` (generic) | Exact name: `shared-vpc-${environment}` (set by SharedVpcStack). |
| PgBouncer namespace | Not specified | Deploy in `platform` namespace. All consumers reference `pgbouncer.platform.svc.cluster.local`. |
| ESO store names | Not specified | SSM → `aws-ssm`, Secrets Manager → `aws-secretsmanager` (confirmed from `kubernetes-platform/charts/external-secrets-config/`). |

### 5.1 Create `PlatformRdsStack` in cdk-monitoring

File: `cdk-monitoring/infra/lib/stacks/kubernetes/platform-rds-stack.ts`

```typescript
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ssm from 'aws-cdk-lib/aws-ssm';

export class PlatformRdsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PlatformRdsProps) {
    super(scope, id, props);

    // Import SharedVpc from cdk-monitoring networking stack
    const vpc = ec2.Vpc.fromLookup(this, 'SharedVpc', {
      vpcName: props.vpcName, // e.g. 'cdk-monitoring-shared-vpc'
    });

    // Security group — allow K8s nodes + pipeline Lambdas
    const dbSg = new ec2.SecurityGroup(this, 'PlatformRdsSg', {
      vpc,
      description: 'Platform RDS — allow K8s nodes and Lambda subnets',
    });

    dbSg.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(5432),
      'Allow all VPC traffic on 5432'
    );

    // RDS PostgreSQL 16 with pgvector
    const instance = new rds.DatabaseInstance(this, 'PlatformRds', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_3,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.MICRO // upgrade to SMALL when production traffic warrants
      ),
      vpc,
      // SharedVpc has PUBLIC subnets only (natGateways: 0, no PRIVATE_WITH_EGRESS).
      // publiclyAccessible defaults to false — security group IS the firewall.
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      publiclyAccessible: false,
      securityGroups: [dbSg],
      databaseName: 'tucaken',
      credentials: rds.Credentials.fromGeneratedSecret('postgres', {
        secretName: `k8s-${props.targetEnvironment}/platform-rds/credentials`,
      }),
      storageEncrypted: true,
      deletionProtection: props.environment === 'production',
      removalPolicy: props.environment === 'production'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      parameterGroup: new rds.ParameterGroup(this, 'PgParams', {
        engine: rds.DatabaseInstanceEngine.postgres({
          version: rds.PostgresEngineVersion.VER_16_3,
        }),
        parameters: {
          'shared_preload_libraries': 'pg_stat_statements',
          'max_connections': '100',
        },
      }),
    });

    // SSM Parameters — consumed by K8s pods via ESO
    const params = {
      host: instance.dbInstanceEndpointAddress,
      port: instance.dbInstanceEndpointPort,
      database: 'tucaken',
      user: 'postgres',
      'secret-arn': instance.secret!.secretArn,
      'sg-id': dbSg.securityGroupId,
    };

    Object.entries(params).forEach(([key, value]) => {
      new ssm.StringParameter(this, `Param-${key}`, {
        parameterName: `/k8s/${props.targetEnvironment}/platform-rds/${key}`,
        stringValue: value,
      });
    });
  }
}
```

### 5.2 Schema Bootstrap as K8s Job (ArgoCD PostSync Hook)

File: `kubernetes-platform/charts/platform-rds/templates/bootstrap-job.yaml`

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: platform-rds-bootstrap
  annotations:
    argocd.argoproj.io/hook: PostSync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
spec:
  ttlSecondsAfterFinished: 3600
  template:
    spec:
      restartPolicy: OnFailure
      serviceAccountName: platform-rds-bootstrap-sa
      containers:
      - name: bootstrap
        image: <ECR>/platform-rds-bootstrap:latest
        envFrom:
        - secretRef:
            name: platform-rds-credentials   # synced by ESO
        - configMapRef:
            name: platform-rds-config        # host, port, database
```

The bootstrap image runs all DDL idempotently — `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE EXTENSION IF NOT EXISTS vector`. Full DDL is in [Section 11](#11-full-schema-reference).

### 5.3 ESO Manifests

File: `kubernetes-platform/charts/platform-rds/external-secrets/rds-credentials.yaml`

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: platform-rds-credentials
spec:
  secretStoreRef:
    name: aws-secretsmanager
    kind: ClusterSecretStore
  target:
    name: platform-rds-credentials
  data:
  - secretKey: PGPASSWORD
    remoteRef:
      key: k8s-development/platform-rds/credentials
      property: password
  - secretKey: PGUSER
    remoteRef:
      key: k8s-development/platform-rds/credentials
      property: username
```

File: `kubernetes-platform/charts/platform-rds/external-secrets/rds-config.yaml`

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: platform-rds-config
spec:
  secretStoreRef:
    name: aws-ssm
    kind: ClusterSecretStore
  target:
    name: platform-rds-config
    template:
      type: Opaque
      data:
        PGHOST: "{{ .host }}"
        PGPORT: "{{ .port }}"
        PGDATABASE: "{{ .database }}"
  data:
  - secretKey: host
    remoteRef:
      key: /k8s/development/platform-rds/host
  - secretKey: port
    remoteRef:
      key: /k8s/development/platform-rds/port
  - secretKey: database
    remoteRef:
      key: /k8s/development/platform-rds/database
```

### 5.4 Verification Checklist

```bash
# Confirm RDS is reachable from a debug pod inside the cluster
kubectl run pg-debug --rm -it --image=postgres:16 -- \
  psql -h $PGHOST -U $PGUSER -d tucaken -c '\l'

# Confirm pgvector extension installed
psql -c '\dx' | grep vector

# Confirm all tables created
psql -c '\dt'

# Confirm bootstrap Job completed
kubectl get jobs -n default | grep platform-rds-bootstrap
```

---

## 6. Phase 2 — Content Migration

**Goal:** Migrate DynamoDB `articles`, `job_applications`, `resumes` tables to PostgreSQL. Update `admin-api` and `public-api` pods to use `pg` instead of `DocumentClient`.

**Estimated time:** 2-3 days

**Prerequisite:** Phase 1 complete and verified.

### 6.1 Export DynamoDB Data

```bash
# Articles table
aws dynamodb scan \
  --table-name tucaken-articles-development \
  --output json > /tmp/articles-export.json

# Job applications
aws dynamodb scan \
  --table-name tucaken-job-applications-development \
  --output json > /tmp/job-applications-export.json

# Resumes
aws dynamodb scan \
  --table-name tucaken-resumes-development \
  --output json > /tmp/resumes-export.json
```

### 6.2 Migration Script (runs as K8s Job)

File: `kubernetes-platform/charts/platform-rds/migration/migrate-dynamo.ts`

```typescript
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { Pool } from 'pg';

const dynamo = new DynamoDBClient({ region: 'eu-west-1' });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrateArticles() {
  const result = await dynamo.send(new ScanCommand({
    TableName: process.env.ARTICLES_TABLE!,
  }));

  for (const raw of result.Items ?? []) {
    const item = unmarshall(raw);
    await pool.query(`
      INSERT INTO articles (
        slug, title, excerpt, content_md, tags,
        status, ai_generated, ai_model, published_at, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (slug) DO NOTHING
    `, [
      item.slug,
      item.title,
      item.excerpt ?? null,
      item.content ?? item.contentMd,
      item.tags ?? [],
      item.status ?? 'published',
      item.aiGenerated ?? false,
      item.aiModel ?? null,
      item.publishedAt ? new Date(item.publishedAt) : null,
      item.createdAt ? new Date(item.createdAt) : new Date(),
    ]);
  }

  console.log(`Migrated ${result.Items?.length ?? 0} articles`);
}

async function migrateJobApplications() {
  const result = await dynamo.send(new ScanCommand({
    TableName: process.env.JOB_APPLICATIONS_TABLE!,
  }));

  for (const raw of result.Items ?? []) {
    const item = unmarshall(raw);
    await pool.query(`
      INSERT INTO job_applications (
        id, user_id, company, role, job_url,
        job_description, kanban_status, applied_at, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (id) DO NOTHING
    `, [
      item.id ?? crypto.randomUUID(),
      item.userId,
      item.company,
      item.role,
      item.jobUrl ?? null,
      item.jobDescription,
      item.status ?? 'saved',
      item.appliedAt ? new Date(item.appliedAt) : null,
      item.createdAt ? new Date(item.createdAt) : new Date(),
    ]);
  }
}

// Run all migrations
await migrateArticles();
await migrateJobApplications();
console.log('Migration complete');
await pool.end();
```

### 6.3 Dual-Write Validation Period (minimum 1 week)

During this period, all write operations go to **both** DynamoDB and PostgreSQL. Reads come from DynamoDB. A validation endpoint compares results:

```typescript
// Temporary validation middleware in admin-api
async function validateArticle(slug: string) {
  const [dynamoResult, pgResult] = await Promise.all([
    dynamoClient.getArticle(slug),
    pgClient.getArticle(slug),
  ]);

  if (dynamoResult.content !== pgResult.content) {
    logger.warn({ slug, event: 'content_mismatch' });
  }

  return dynamoResult; // still serving from Dynamo during validation
}
```

### 6.4 Cut Over

Once validation passes for 7+ days with zero mismatches:

1. Switch all reads to PostgreSQL
2. Remove DynamoDB write path
3. Remove `aws-sdk/client-dynamodb` imports from `admin-api` and `public-api`
4. Mark DynamoDB tables read-only (enforce-readonly-dynamodb-aspect already exists)

---

## 7. Phase 3 — Ingestion Pipeline

**Goal:** Collapse 3 Lambda functions + S3 staging into a single Kubernetes Job. ESO manifests for ingestion already exist in `kubernetes-platform/charts/ingestion/`.

**Estimated time:** 2 days

**Prerequisite:** Phase 1 complete.

### 7.1 The Collapse

The 3 Lambda chain existed purely to avoid NAT Gateway costs. In Kubernetes:

```
Before (Lambda):
  Trigger (no VPC) → Fetcher (no VPC, GitHub) → S3 → Worker (isolated VPC, RDS)

After (K8s Job):
  Single pod process:
    1. GitHub API  (node has internet, no VPC constraint)
    2. Chunk + hash check + embed (Bedrock via IRSA)
    3. Upsert RDS document_embeddings (same VPC, TCP 5432)
    4. Prune stale chunks
    5. UPDATE repo_sync_state
    EXIT 0
```

### 7.2 Job Entrypoint

File: `ai-applications/applications/ingestion/src/run-ingestion.ts`

```typescript
import { parseEnv } from './env';
import { GitHubAdapter } from './adapters/github-adapter';
import { IngestionPipeline } from './pipeline/ingestion-pipeline';
import { RdsVectorStore } from './stores/rds-vector-store';
import { updateSyncState } from './db/sync-state';

const { userId, repoFullName, forceReindex, pipelineRunId } = parseEnv();

async function main() {
  await updateSyncState(repoFullName, userId, 'syncing');

  // Step 1: Fetch from GitHub directly (no S3 staging needed)
  const github = new GitHubAdapter(process.env.GITHUB_TOKEN!);
  const files = await github.listAndFetchFiles(repoFullName);

  // Step 2-5: Existing pipeline logic — unchanged
  const store = new RdsVectorStore();
  const pipeline = new IngestionPipeline(store);
  const report = await pipeline.run({ userId, repoFullName, files, forceReindex });

  await updateSyncState(repoFullName, userId, 'complete', report);
  console.log(JSON.stringify({ event: 'ingestion_complete', ...report }));
}

main().catch(async (err) => {
  await updateSyncState(repoFullName, userId, 'error', { errorMessage: String(err) });
  console.error(JSON.stringify({ event: 'ingestion_failed', error: String(err) }));
  process.exit(1); // K8s marks Job as failed, respects backoffLimit
});
```

### 7.3 Job Manifest

File: `kubernetes-platform/charts/ingestion/templates/ingestion-job.yaml`

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: ingestion-{{ .Values.userId }}-{{ .Values.repoSlug }}-{{ .Values.timestamp }}
  labels:
    app: ingestion-worker
spec:
  ttlSecondsAfterFinished: 3600
  backoffLimit: 2
  activeDeadlineSeconds: 900   # 15 min — same as original Worker Lambda
  template:
    spec:
      restartPolicy: Never
      serviceAccountName: ingestion-sa   # IRSA: bedrock:InvokeModel
      containers:
      - name: worker
        image: {{ .Values.image.repository }}:{{ .Values.image.tag }}
        env:
        - name: USER_ID
          value: {{ .Values.userId }}
        - name: REPO_FULL_NAME
          value: {{ .Values.repoFullName }}
        - name: FORCE_REINDEX
          value: {{ .Values.forceReindex | quote }}
        envFrom:
        - secretRef:
            name: platform-rds-credentials
        - configMapRef:
            name: platform-rds-config
        - secretRef:
            name: ingestion-secrets      # GITHUB_TOKEN from ESO
        resources:
          requests:
            memory: "512Mi"
            cpu: "250m"
          limits:
            memory: "1Gi"
            cpu: "500m"
```

### 7.4 Admin-API Trigger Endpoint

```typescript
// admin-api/src/routes/ingestion.ts
import * as k8s from '@kubernetes/client-node';

const kc = new k8s.KubeConfig();
kc.loadFromCluster(); // runs inside K8s, uses service account token

const batchApi = kc.makeApiClient(k8s.BatchV1Api);

router.post('/ingestion/trigger', async (ctx) => {
  const { userId, repoFullName, forceReindex = false } = ctx.req.body;

  const timestamp = Date.now();
  const repoSlug = repoFullName.replace('/', '-');

  // Create K8s Job — replaces lambda.invoke()
  await batchApi.createNamespacedJob('default', {
    metadata: {
      name: `ingestion-${userId}-${repoSlug}-${timestamp}`,
      labels: { app: 'ingestion-worker', userId, repoSlug },
    },
    spec: {
      // ... job spec from template above, with values substituted
    },
  });

  return ctx.json({ status: 'queued', userId, repoFullName, forceReindex });
});
```

### 7.5 What to Delete from CDK

```
ai-applications/infra/lib/stacks/
  ├── rds-pgvector-stack.ts          DELETE
  │     └── isolated VPC
  │     └── SM Interface Endpoint
  │     └── Bedrock Runtime Endpoint
  │     └── S3 Gateway Endpoint
  │     └── Bootstrap Lambda
  └── ingestion-stack.ts             DELETE
        └── Trigger Lambda
        └── Fetcher Lambda
        └── Worker Lambda
        └── S3 staging bucket
        └── API Gateway
        └── GitHub token secret       MIGRATE to platform secret
```

---

## 8. Phase 4 — AI Pipelines

**Goal:** Replace PipelineStack and StrategistPipelineStack with Kubernetes Jobs and SSE streaming.

**Estimated time:** 3 days

**Prerequisite:** Phase 1 complete.

### 8.1 Article Pipeline → K8s Job

**Pattern:** Background Job + status polling. Admin triggers from dashboard, watches progress via polling.

```
Admin: POST /api/admin/pipelines/article/:slug
  → admin-api: INSERT pipeline_runs (status=queued)
  → admin-api: kubectl apply Job
  → admin-api: 202 { pipelineRunId }

Job pod (article-pipeline image):
  Research  → Bedrock Haiku  → structured brief
  Writer    → Bedrock Sonnet (extended thinking) → MDX content
  QA        → Bedrock Sonnet → quality score + edits
  Persist   → UPDATE articles (status=review)
              UPDATE pipeline_runs (status=complete)

Admin: polls GET /api/admin/pipelines/:id
  watches: queued → researching → writing → qa → complete
```

**Job Entrypoint** (replaces 4 Lambda handlers + state machine):

```typescript
// article-pipeline/src/run-pipeline.ts
const { slug, pipelineRunId } = parseEnv();

try {
  await updatePipelineRun(pipelineRunId, 'researching');
  const research = await executeResearchAgent(slug);     // existing code, unchanged

  await updatePipelineRun(pipelineRunId, 'writing');
  const draft = await executeWriterAgent(slug, research); // existing code, unchanged

  await updatePipelineRun(pipelineRunId, 'qa');
  const final = await executeQaAgent(slug, research, draft); // existing code, unchanged

  await persistArticle(slug, final);
  await updatePipelineRun(pipelineRunId, 'complete');

} catch (err) {
  await updatePipelineRun(pipelineRunId, 'failed', String(err));
  process.exit(1); // K8s marks Job failed, respects backoffLimit: 2
}
```

**Note:** `executeResearchAgent`, `executeWriterAgent`, `executeQaAgent` are **unchanged**. Only the Lambda handler wrapper is replaced by the entrypoint above.

---

### 8.2 Strategist Pipeline → K8s Job

**Pattern:** Background Job + status polling. Same structure as article pipeline.

```typescript
// strategist-pipeline/src/run-pipeline.ts
const { applicationId, userId, pipelineRunId } = parseEnv();

try {
  await updateJobApplication(applicationId, 'researching');
  const research = await executeResearchAgent(applicationId, userId);

  await updateJobApplication(applicationId, 'analysing');
  const analysis = await executeStrategistAgent(applicationId, research);

  await updateJobApplication(applicationId, 'building');
  const resume = await executeResumeBuilderAgent(applicationId, analysis);

  await persistResume(applicationId, resume, analysis);
  await updateJobApplication(applicationId, 'complete');

} catch (err) {
  await updateJobApplication(applicationId, 'failed', String(err));
  process.exit(1);
}
```

---

### 8.3 Coaching Pipeline → SSE Streaming

**Pattern:** Synchronous SSE. User clicks "Coach me for System Design". Watches coaching content stream in real time.

```typescript
// admin-api/src/routes/coaching.ts
router.get('/api/admin/applications/:slug/coach', async (ctx) => {
  const { stage } = ctx.req.query;

  // CoachLoader — what was an entire Lambda + state
  const [application, completedStages, relevantChunks] = await Promise.all([
    db.getJobApplication(ctx.params.slug),
    db.getCompletedStages(ctx.params.slug),
    db.queryHybrid(ctx.user.id, stage),
  ]);

  return streamSSE(ctx, async (stream) => {
    const bedrockStream = await bedrock.invokeModelWithResponseStream({
      modelId: process.env.COACH_MODEL,
      body: buildCoachPrompt(application, completedStages, relevantChunks, stage),
    });

    let fullContent = '';
    for await (const token of bedrockStream) {
      fullContent += token;
      await stream.writeSSE({ data: token });
    }

    // Persist complete coaching content after stream
    await db.upsertCoachingContent(ctx.params.slug, stage, fullContent);
    await stream.writeSSE({ data: '[DONE]' });
  });
});
```

The 2-state CoachLoader → Coach state machine becomes one Hono route.

---

### 8.4 What to Delete from CDK

```
PipelineStack — delete entirely:
  Trigger Lambda
  Research Lambda
  Writer Lambda
  QA Lambda
  Publish Lambda
  Version History Lambda
  SQS queue
  Step Functions state machine
  S3 event notification
  API Gateway trigger

StrategistPipelineStack — delete entirely:
  Research Lambda
  Strategist Lambda
  ResumeBuilder Lambda
  Persist Lambda
  CoachLoader Lambda
  Coach Lambda
  SQS DLQs
  Step Functions state machines (2)
```

---

## 9. Phase 5 — Cleanup

**Goal:** Delete orphaned CDK stacks and decommission DynamoDB tables.

**Estimated time:** 1 day

**Prerequisite:** Phases 2, 3, 4 complete and traffic confirmed clean for 7+ days.

### 9.1 Public API Stack

The `public-api` pod already runs in `kubernetes-platform/charts/public-api`. This is CDK code deletion only — no application changes.

```bash
# Verify pod is serving traffic
kubectl get pods -n default -l app=public-api
kubectl logs -l app=public-api --tail=50

# Delete the CDK stack
cd ai-applications/infra
npx cdk destroy PublicApiStack-development
```

### 9.2 DynamoDB Decommission

Only after all reads have moved to PostgreSQL and dual-write validation has passed:

```bash
# Mark tables read-only first (use existing aspect if available)
# Then delete

aws dynamodb delete-table --table-name tucaken-articles-development
aws dynamodb delete-table --table-name tucaken-job-applications-development
aws dynamodb delete-table --table-name tucaken-resumes-development

# Delete CDK stacks
npx cdk destroy AiContentStack-development
npx cdk destroy StrategistDataStack-development
```

### 9.3 Remove enforce-readonly-dynamodb-aspect.ts

Once DynamoDB tables are deleted, this CDK aspect is no longer needed:

```bash
rm ai-applications/infra/lib/aspects/enforce-readonly-dynamodb-aspect.ts
# Remove from app.ts
```

---

## 10. Phase 6 — Self-Healing Extension

**Goal:** Extend the self-healing agent to cover Kubernetes workloads. Currently the agent sees AWS/EC2 events only. Grafana alert rules exist but route nowhere.

**Estimated time:** 1 sprint (5 days)

**Prerequisite:** All other phases complete. This phase is additive — existing self-healing continues working throughout.

### 10.1 Current Gap

```
What Grafana can see (Prometheus data):   What self-healing agent can see:
  CrashLoopBackOff          ✓               EC2 node failure           ✓
  OOMKilled                 ✓               Node not joining cluster   ✓
  ArgoCD sync failed        ✓               CloudWatch metrics         ✓
  Job failed                ✓               SSM commands               ✓
  PVC not bound             ✓
  ImagePullBackOff          ✓
  Node NotReady (K8s)       ✓

Connection between them: NONE
Grafana alerts fire in UI and disappear. Nothing acts on them.
```

### 10.2 Step 1 — Alert Bridge Lambda

A new Lambda with a Function URL receives Grafana webhook payloads and normalises them onto the existing SQS FIFO queue.

```
Grafana alert fires
  │  POST /webhook (Grafana unified alerting payload)
  ▼
Alert Bridge Lambda (Function URL — no API Gateway)
  ├── Parse Grafana payload
  ├── Normalise to self-healing event schema
  ├── Build dedup key: {namespace}/{alertname}/{pod}
  └── SQS SendMessage → existing FIFO queue
         MessageGroupId = dedup key
         MessageDeduplicationId = SHA256(dedup key + fired_at)
```

The self-healing agent Lambda consumes the same queue. It receives the normalised event and uses the `source: "grafana"` field to select the Kubernetes tool group.

**CDK addition** in `SelfHealingAgentStack`:

```typescript
// Add to existing SelfHealingAgentStack
const alertBridge = new lambdaNode.NodejsFunction(this, 'AlertBridge', {
  entry: 'applications/self-healing/src/alert-bridge/index.ts',
  handler: 'handler',
  runtime: lambda.Runtime.NODEJS_20_X,
  timeout: cdk.Duration.seconds(10),
  environment: {
    QUEUE_URL: this.sqsFifoQueue.queueUrl,
    GRAFANA_WEBHOOK_SECRET: '{{resolve:ssm:/self-healing/grafana-webhook-secret}}',
  },
});

this.sqsFifoQueue.grantSendMessages(alertBridge);

const bridgeFnUrl = alertBridge.addFunctionUrl({
  authType: lambda.FunctionUrlAuthType.NONE,
  cors: { allowedOrigins: ['*'] },
});

// Export URL to SSM for ESO to sync into Grafana values
new ssm.StringParameter(this, 'BridgeFnUrl', {
  parameterName: '/self-healing/alert-bridge-url',
  stringValue: bridgeFnUrl.url,
});
```

**Grafana contact point** in `alerting-configmap.yaml`:

```yaml
contactPoints:
  - name: self-healing-agent
    receivers:
      - uid: self-healing-webhook
        type: webhook
        settings:
          url: ${ALERT_BRIDGE_URL}   # ESO syncs from SSM
          httpMethod: POST
          authorization_credentials: ${GRAFANA_WEBHOOK_SECRET}

policies:
  - receiver: self-healing-agent
    matchers:
      - label: severity
        op: "="
        value: critical
    routes:
      - matchers:
          - label: source
            op: "="
            value: kubernetes
        receiver: self-healing-agent
```

### 10.3 Step 2 — Missing Prometheus Alert Rules

Add to `kubernetes-platform/charts/monitoring/chart/templates/grafana/alerting-configmap.yaml`:

```yaml
# OOMKilled — distinct from CrashLoop, different remediation
- uid: alert-oomkilled
  title: Container OOMKilled
  condition: C
  data:
    - refId: A
      expr: kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1
  for: 0s
  labels:
    severity: warning
    source: kubernetes

# ImagePullBackOff — deployment stuck, not self-remediating
- uid: alert-imagepull-backoff
  title: ImagePullBackOff
  condition: C
  data:
    - refId: A
      expr: kube_pod_container_status_waiting_reason{reason=~"ImagePullBackOff|ErrImagePull"} == 1
  for: 5m
  labels:
    severity: warning
    source: kubernetes

# Failed Job — ingestion or pipeline job failed
- uid: alert-job-failed
  title: Kubernetes Job Failed
  condition: C
  data:
    - refId: A
      expr: kube_job_status_failed > 0
  for: 0s
  labels:
    severity: critical
    source: kubernetes

# ArgoCD OutOfSync > 10 minutes
- uid: alert-argocd-sync-failed
  title: ArgoCD Application OutOfSync
  condition: C
  data:
    - refId: A
      expr: argocd_app_info{sync_status="OutOfSync"} == 1
  for: 10m
  labels:
    severity: warning
    source: kubernetes

# PVC not bound
- uid: alert-pvc-not-bound
  title: PVC Not Bound
  condition: C
  data:
    - refId: A
      expr: kube_persistentvolumeclaim_status_phase{phase!="Bound"} == 1
  for: 5m
  labels:
    severity: critical
    source: kubernetes
```

The `source: kubernetes` label routes these to the K8s tool group in the agent's system prompt.

### 10.4 Step 3 — Eight New MCP Tool Lambdas

All tools authenticate with a Kubernetes ServiceAccount token stored in Secrets Manager. All call the K8s API server via the NLB endpoint. No VPC placement needed — these are HTTPS calls, not TCP to RDS.

**RBAC manifest** in `kubernetes-platform/charts/self-healing/`:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: self-healing-agent
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: self-healing-agent
rules:
- apiGroups: [""]
  resources: ["pods", "nodes", "persistentvolumeclaims"]
  verbs: ["get", "list"]
- apiGroups: [""]
  resources: ["pods/log"]
  verbs: ["get"]
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["get", "list", "patch"]
- apiGroups: ["batch"]
  resources: ["jobs"]
  verbs: ["get", "list", "delete"]
- apiGroups: ["argoproj.io"]
  resources: ["applications"]
  verbs: ["get", "list"]
- apiGroups: [""]
  resources: ["nodes"]
  verbs: ["patch"]   # cordon/uncordon
```

**Tool summary:**

| Tool Lambda | K8s Call | Remediates |
|---|---|---|
| `get-pod-status` | `GET /api/v1/namespaces/{ns}/pods` | CrashLoop, OOMKilled diagnosis |
| `get-pod-logs` | `GET .../pods/{pod}/log?tailLines=100` | Error root cause analysis |
| `restart-deployment` | `PATCH .../deployments/{name}` | CrashLoop, stuck rollout |
| `delete-failed-job` | `DELETE .../jobs/{name}` | Stuck ingestion/pipeline job |
| `get-argocd-sync-status` | `GET argoproj.io/.../applications/{name}` | Sync failure diagnosis |
| `trigger-argocd-sync` | ArgoCD API `POST .../applications/{name}/sync` | OutOfSync remediation |
| `get-pvc-status` | `GET .../persistentvolumeclaims` | PVC not bound diagnosis |
| `get-prometheus-query` | Prometheus HTTP `/api/v1/query` | Metric-based root cause |

### 10.5 Bootstrap Orchestrator — Revised Routing

The Step Functions bootstrap orchestrator stays, but its routing changes.

**Before:** All node failures → SSM bootstrap script → Step Functions wait
**After:**
- Worker nodes → `cordon_node` K8s tool + EC2 terminate → ASG replaces → Cluster Autoscaler joins
- Control plane node → `remediate-node-bootstrap` → Step Functions (etcd membership requires deliberate steps)

Update the agent's system prompt:

```
When a worker node is NotReady:
  1. Call get-node-conditions to confirm the condition
  2. Call cordon-node to prevent new scheduling
  3. Call describe-ec2-instances to get instance ID
  4. Terminate the EC2 instance (ASG will replace it)
  5. Cluster Autoscaler will join the replacement automatically
  Do NOT call remediate-node-bootstrap for worker nodes.

When the control plane node is unhealthy:
  1. Call remediate-node-bootstrap
  2. This fires the Step Functions bootstrap orchestrator
  3. Wait for completion report
```

---

## 11. Full Schema Reference

```sql
-- EXTENSION
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- IDENTITY DOMAIN
CREATE TABLE users (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email             TEXT        UNIQUE NOT NULL,
  full_name         TEXT,
  avatar_url        TEXT,
  plan              TEXT        NOT NULL DEFAULT 'free',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE oauth_connections (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT        NOT NULL,
  provider_user_id  TEXT        NOT NULL,
  username          TEXT        NOT NULL,
  access_token_enc  TEXT        NOT NULL,
  scopes            TEXT[],
  connected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider)
);

-- KNOWLEDGE DOMAIN
CREATE TABLE repositories (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT        NOT NULL,
  full_name         TEXT        NOT NULL,
  description       TEXT,
  primary_language  TEXT,
  topics            TEXT[],
  is_private        BOOLEAN     NOT NULL DEFAULT false,
  index_status      TEXT        NOT NULL DEFAULT 'pending',
  indexed_at        TIMESTAMPTZ,
  error_message     TEXT,
  added_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider, full_name)
);

CREATE TABLE document_embeddings (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           TEXT        NOT NULL,
  repo_full_name    TEXT        NOT NULL,
  file_path         TEXT        NOT NULL,
  heading           TEXT,
  content           TEXT        NOT NULL,
  content_tsv       TSVECTOR    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  file_type         TEXT,
  tags              TEXT[],
  chunk_index       INTEGER     NOT NULL,
  total_chunks      INTEGER     NOT NULL,
  content_hash      TEXT        NOT NULL,
  embedding         vector(1024) NOT NULL,
  last_synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE repo_sync_state (
  user_id           TEXT        NOT NULL,
  repo_full_name    TEXT        NOT NULL,
  sync_status       TEXT        NOT NULL DEFAULT 'pending',
  last_synced_at    TIMESTAMPTZ,
  file_count        INTEGER     NOT NULL DEFAULT 0,
  chunk_count       INTEGER     NOT NULL DEFAULT 0,
  error_message     TEXT,
  PRIMARY KEY (user_id, repo_full_name)
);

-- CAREER DOMAIN
CREATE TABLE job_applications (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company           TEXT        NOT NULL,
  role              TEXT        NOT NULL,
  job_url           TEXT,
  job_description   TEXT        NOT NULL,
  job_description_tsv TSVECTOR  GENERATED ALWAYS AS (
    to_tsvector('english', company || ' ' || role || ' ' || job_description)
  ) STORED,
  kanban_status     TEXT        NOT NULL DEFAULT 'saved',
  applied_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE resumes (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_application_id UUID       REFERENCES job_applications(id) ON DELETE SET NULL,
  version           INTEGER     NOT NULL DEFAULT 1,
  content_json      JSONB       NOT NULL,
  rendered_html     TEXT,
  source_chunk_ids  UUID[],
  generated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE interview_stages (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_application_id UUID       NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  stage_type        TEXT        NOT NULL,
  scheduled_at      TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  outcome           TEXT,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE coaching_content (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_application_id UUID       NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  stage_type        TEXT        NOT NULL,
  topics_to_study   JSONB,
  expected_questions JSONB,
  personal_highlights JSONB,
  source_chunk_ids  UUID[],
  generated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_application_id, stage_type)
);

-- CONTENT DOMAIN
CREATE TABLE articles (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              TEXT        UNIQUE NOT NULL,
  title             TEXT        NOT NULL,
  excerpt           TEXT,
  content_md        TEXT        NOT NULL,
  content_tsv       TSVECTOR    GENERATED ALWAYS AS (
    to_tsvector('english', title || ' ' || COALESCE(excerpt,'') || ' ' || content_md)
  ) STORED,
  tags              TEXT[],
  author_id         UUID        REFERENCES users(id),
  status            TEXT        NOT NULL DEFAULT 'draft',
  ai_generated      BOOLEAN     NOT NULL DEFAULT false,
  ai_model          TEXT,
  published_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- PLATFORM DOMAIN
CREATE TABLE pipeline_runs (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id),
  pipeline_type     TEXT        NOT NULL,
  reference_id      TEXT,
  status            TEXT        NOT NULL DEFAULT 'queued',
  error_message     TEXT,
  metadata          JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE api_keys (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT        NOT NULL,
  key_hash          TEXT        NOT NULL UNIQUE,
  key_prefix        TEXT        NOT NULL,
  scopes            TEXT[],
  last_used_at      TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ,
  is_active         BOOLEAN     NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE app_config (
  key               TEXT        PRIMARY KEY,
  value             JSONB       NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE ingestion_audit_log (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id),
  repo_full_name    TEXT        NOT NULL,
  triggered_by      TEXT,
  status            TEXT        NOT NULL,
  duration_ms       INTEGER,
  chunks_embedded   INTEGER,
  chunks_skipped    INTEGER,
  chunks_pruned     INTEGER,
  error_message     TEXT,
  triggered_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- INDEXES
CREATE UNIQUE INDEX idx_embeddings_natural_key
  ON document_embeddings (user_id, repo_full_name, file_path, chunk_index);
CREATE INDEX idx_embeddings_hnsw
  ON document_embeddings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE INDEX idx_embeddings_content_tsv
  ON document_embeddings USING GIN (content_tsv);
CREATE INDEX idx_articles_slug   ON articles (slug);
CREATE INDEX idx_articles_status ON articles (status, published_at DESC);
CREATE INDEX idx_articles_tags   ON articles USING GIN (tags);
CREATE INDEX idx_articles_tsv    ON articles USING GIN (content_tsv);
CREATE INDEX idx_job_apps_user   ON job_applications (user_id, kanban_status);
CREATE INDEX idx_pipeline_runs   ON pipeline_runs (user_id, pipeline_type, status);
```

---

## 12. CDK Stack Disposition

| Stack | Repo | Action | Replaced by |
|---|---|---|---|
| `RdsPgVectorStack` | ai-applications | **DELETE** | `PlatformRdsStack` in cdk-monitoring |
| `IngestionStack` | ai-applications | **DELETE** | `kubernetes-platform/charts/ingestion` K8s Job |
| `PipelineStack` | ai-applications | **DELETE** | `kubernetes-platform/charts/article-pipeline` K8s Job |
| `StrategistPipelineStack` | ai-applications | **DELETE** | K8s Job + SSE route in admin-api |
| `PublicApiStack` | ai-applications | **DELETE** | Pod already running |
| `AiContentStack` | ai-applications | **DELETE** (Phase 5) | articles table in Platform RDS |
| `StrategistDataStack` | ai-applications | **DELETE** (Phase 5) | career tables in Platform RDS |
| `BedrockAgentStack` | ai-applications | **KEEP** | AWS managed, Lambda is correct |
| `BedrockKbStack` | ai-applications | **KEEP** | AWS managed |
| `BedrockApiStack` | ai-applications | **KEEP** | Thin proxy — acceptable |
| `PlatformRdsStack` | cdk-monitoring | **NEW** | Replaces RdsPgVectorStack |
| `SelfHealingAgentStack` | cdk-monitoring | **EXTEND** | Add bridge Lambda + 8 K8s tool Lambdas |

**After all phases:** `ai-applications` CDK = BedrockAgentStack + BedrockKbStack + BedrockApiStack. ~200 lines. Everything else runs on K8s nodes.

---

## 13. PgBouncer — Connection Pooling

RDS `t4g.micro` has a `max_connections` limit of approximately 85. With multiple pods (admin-api, public-api, article-pipeline Jobs, strategist Jobs, ingestion Jobs) each maintaining their own pool, connections will be exhausted under concurrent load.

**Solution:** PgBouncer as a cluster-internal connection pooler.

```yaml
# kubernetes-platform/charts/pgbouncer/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pgbouncer
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: pgbouncer
        image: bitnami/pgbouncer:latest
        env:
        - name: POSTGRESQL_HOST
          valueFrom:
            configMapKeyRef:
              name: platform-rds-config
              key: PGHOST
        - name: POSTGRESQL_PASSWORD
          valueFrom:
            secretKeyRef:
              name: platform-rds-credentials
              key: PGPASSWORD
        - name: PGBOUNCER_POOL_MODE
          value: transaction
        - name: PGBOUNCER_MAX_CLIENT_CONN
          value: "200"
        - name: PGBOUNCER_DEFAULT_POOL_SIZE
          value: "20"
        ports:
        - containerPort: 5432
```

All pods connect to `pgbouncer:5432` (cluster-internal DNS). PgBouncer maintains a pool of 20 real connections to RDS. 200 client connections fan into 20 server connections.

**Deploy PgBouncer in Phase 1, before any pod connects to RDS.**

---

## Execution Order Summary

```
Phase 1  PlatformRdsStack + PgBouncer + ESO + Schema Bootstrap
         ↓
Phase 2  DynamoDB → PostgreSQL migration (dual-write → cut over → validate)
         ↓
Phase 3  Ingestion: 3 Lambdas → 1 K8s Job (delete IngestionStack + RdsPgVectorStack)
         ↓
Phase 4  Pipelines: Step Functions → K8s Jobs + SSE (delete PipelineStack + StrategistPipelineStack)
         ↓
Phase 5  Cleanup: delete PublicApiStack, AiContentStack, StrategistDataStack, DynamoDB tables
         ↓
Phase 6  Self-healing extension: alert bridge Lambda + K8s MCP tools + alert rules
```

After Phase 5, monthly AWS cost recovers approximately **$31/month** in VPC endpoints and API Gateway. After Phase 6, the self-healing agent covers both AWS infrastructure and Kubernetes workloads from a single event-driven pipeline.