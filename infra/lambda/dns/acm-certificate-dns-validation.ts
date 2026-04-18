/** @format */

/**
 * ACM Certificate with Cross-Account DNS Validation Lambda
 *
 * This Lambda function handles ACM certificate creation and DNS validation
 * when the Route 53 hosted zone exists in a different AWS account:
 *
 * 1. Creates ACM certificate in current account
 * 2. Assumes cross-account role in root account
 * 3. Creates Route 53 DNS validation records in root account's hosted zone
 * 4. Waits for certificate validation to complete
 * 5. Cleans up DNS records on stack deletion
 *
 * Architecture:
 * - Runs OUTSIDE VPC (no VPC dependencies)
 * - CloudFormation Custom Resource (lifecycle management)
 * - Cross-account IAM role assumption
 * - Idempotent operations (safe retries)
 *
 * IAM Requirements:
 * - Local account: ACM certificate management
 * - Root account: Route 53 DNS record management via assumed role
 *
 * Timeout Considerations:
 * - Certificate validation typically takes 5-10 minutes
 * - Lambda timeout should be at least 15 minutes
 * - Consider using Step Functions for longer operations
 *
 * @see https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html
 */

import {
  ACMClient,
  RequestCertificateCommand,
  DescribeCertificateCommand,
  DeleteCertificateCommand,
  ListCertificatesCommand,
  CertificateStatus,
} from "@aws-sdk/client-acm";
import {
  Route53Client,
  ChangeResourceRecordSetsCommand,
  RRType,
  ChangeAction,
} from "@aws-sdk/client-route-53";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import {
  CloudFormationCustomResourceEvent,
  Context,
} from "aws-lambda";




// ========================================================================
// ENVIRONMENT VARIABLES
// ========================================================================

const REGION = process.env.AWS_REGION || "eu-west-2";
const POLLING_INTERVAL_MS = 30000; // 30 seconds between validation checks
const MAX_VALIDATION_ATTEMPTS = 20; // 10 minutes total (20 * 30s)

// ========================================================================
// AWS SDK CLIENTS
// ========================================================================

const acmClient = new ACMClient({ region: REGION });
const stsClient = new STSClient({ region: REGION });

// ========================================================================
// TYPES
// ========================================================================

/**
 * Properties from CloudFormation stack
 */
interface AcmCertificateProperties {
  /**
   * Domain name for the certificate (e.g., "monitoring.example.com")
   */
  DomainName: string;

  /**
   * Subject Alternative Names (SANs) for additional domains
   * @example ["*.monitoring.example.com"]
   */
  SubjectAlternativeNames?: string[];

  /**
   * Route 53 Hosted Zone ID in root account
   * @example "Z1234567890ABC"
   */
  HostedZoneId: string;

  /**
   * Cross-account IAM role ARN to assume for Route 53 access
   * @example "arn:aws:iam::123456789012:role/Route53DnsValidationRole"
   */
  CrossAccountRoleArn: string;

  /**
   * Environment name (for tagging)
   */
  Environment: string;

  /**
   * Region for certificate (defaults to Lambda execution region)
   */
  Region?: string;

  /**
   * CloudFront distribution domain name for DNS alias record
   * When provided, creates an A record (Alias) pointing to CloudFront
   * @example "d1234abcd.cloudfront.net"
   */
  CloudFrontDomainName?: string;

  /**
   * Skip certificate creation - only create DNS alias record
   * Used by the DnsAliasRecord custom resource
   */
  SkipCertificateCreation?: string;

  /**
   * Simple A record value (e.g., an Elastic IP address)
   * When provided with SkipCertificateCreation=true and no CloudFrontDomainName,
   * creates a simple A record pointing to this IP address.
   * @example "1.2.3.4"
   */
  RecordValue?: string;
}


/**
 * Cross-account credentials from STS
 */
interface CrossAccountCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

// ========================================================================
// LAMBDA HANDLER
// ========================================================================

/**
 * Response format expected by cr.Provider
 * Note: cr.Provider does NOT expect the full CloudFormation response format.
 * It only expects PhysicalResourceId and Data.
 */
interface CrProviderResponse {
  PhysicalResourceId?: string;
  Data?: Record<string, string>;
  NoEcho?: boolean;
}

/**
 * Lambda handler for CloudFormation Custom Resource (via cr.Provider)
 * 
 * IMPORTANT: cr.Provider expects a simplified response format:
 * - { PhysicalResourceId?: string, Data?: Record<string, any> }
 * - Do NOT return Status, StackId, RequestId, LogicalResourceId
 * - The cr.Provider framework handles building the full CFN response
 */
export const handler = async (
  event: CloudFormationCustomResourceEvent,
  context: Context,
): Promise<CrProviderResponse> => {
  console.log("ACM Certificate Lambda started");
  console.log("Event:", JSON.stringify(event, null, 2));

  try {
    const requestType = event.RequestType;
    console.log(`Request type: ${requestType}`);

    let response: CrProviderResponse;

    switch (requestType) {
      case "Create":
        response = await handleCreate(event, context);
        break;
      case "Update":
        response = await handleUpdate(event, context);
        break;
      case "Delete":
        response = await handleDelete(event, context);
        break;
      default:
        throw new Error(`Unknown request type: ${requestType}`);
    }

    console.log("Handler complete, returning response:", JSON.stringify(response));
    return response;
  } catch (error) {
    console.error("Handler failed:", error);
    // For cr.Provider, throw the error - the framework will handle it
    throw error;
  }
};


// ========================================================================
// CREATE HANDLER
// ========================================================================

/**
 * Handle Create events
 */
async function handleCreate(
  event: CloudFormationCustomResourceEvent,
  _context: Context,
): Promise<CrProviderResponse> {
  const props = event.ResourceProperties as unknown as AcmCertificateProperties;

  const {
    DomainName,
    HostedZoneId,
    CrossAccountRoleArn,
    Environment,
  } = props;

  // Simple A record mode: Create a plain A record pointing to an IP (e.g., EIP)
  if (props.SkipCertificateCreation === 'true' && props.RecordValue && !props.CloudFrontDomainName) {
    console.log(`Simple A record mode: Creating A record for ${DomainName} -> ${props.RecordValue}`);
    console.log(`  Hosted Zone: ${HostedZoneId}`);

    const credentials = await assumeCrossAccountRole(CrossAccountRoleArn);
    await createSimpleARecord(
      HostedZoneId,
      DomainName,
      props.RecordValue,
      credentials,
    );

    return {
      PhysicalResourceId: `dns-a-record-${DomainName}`,
      Data: {
        DomainName,
        RecordValue: props.RecordValue,
        ARecordCreated: 'true',
      },
    };
  }

  // DNS-only mode: Only create CloudFront alias record, skip certificate
  if (props.SkipCertificateCreation === 'true' && props.CloudFrontDomainName) {
    console.log(`DNS-only mode: Creating CloudFront alias for ${DomainName}`);
    console.log(`  CloudFront Domain: ${props.CloudFrontDomainName}`);
    console.log(`  Hosted Zone: ${HostedZoneId}`);

    const credentials = await assumeCrossAccountRole(CrossAccountRoleArn);
    await createCloudFrontAliasRecord(
      HostedZoneId,
      DomainName,
      props.CloudFrontDomainName,
      credentials,
    );

    return {
      PhysicalResourceId: `dns-alias-${DomainName}`,
      Data: {
        DomainName,
        CloudFrontDomainName: props.CloudFrontDomainName,
        AliasRecordCreated: 'true',
      },
    };
  }

  // Full certificate mode: Validate required properties
  validateProperties(props);

  const {
    SubjectAlternativeNames,
    Region,
  } = props;

  const region = Region || REGION;

  console.log(`Creating ACM certificate for ${DomainName}`);
  console.log(`  Hosted Zone: ${HostedZoneId}`);
  console.log(`  Cross-Account Role: ${CrossAccountRoleArn}`);
  console.log(`  Environment: ${Environment}`);
  console.log(`  Region: ${region}`);

  // STEP 1: Request ACM certificate
  const certificateArn = await requestCertificate(
    DomainName,
    SubjectAlternativeNames,
    Environment,
  );

  console.log(`Certificate requested: ${certificateArn}`);

  // STEP 2: Get DNS validation records from ACM
  const validationRecords = await getDnsValidationRecords(certificateArn);

  console.log(`Retrieved ${validationRecords.length} DNS validation record(s)`);

  // STEP 3: Assume cross-account role
  const credentials = await assumeCrossAccountRole(CrossAccountRoleArn);

  console.log("Cross-account role assumed successfully");

  // STEP 4: Create DNS validation records in Route 53
  await createDnsValidationRecords(
    HostedZoneId,
    validationRecords,
    credentials,
  );

  console.log("DNS validation records created");

  // STEP 5: Wait for certificate validation
  await waitForCertificateValidation(certificateArn);

  console.log("Certificate validated successfully");

  // STEP 6: Create CloudFront alias A record (if CloudFrontDomainName provided)
  if (props.CloudFrontDomainName) {
    await createCloudFrontAliasRecord(
      HostedZoneId,
      DomainName,
      props.CloudFrontDomainName,
      credentials,
    );
    console.log("CloudFront alias record created");
  }

  // Return cr.Provider format (only PhysicalResourceId and Data)
  return {
    PhysicalResourceId: certificateArn,
    Data: {
      CertificateArn: certificateArn,
      DomainName,
      ValidationStatus: "SUCCESS",
      HostedZoneId,
      Environment,
      CloudFrontAliasCreated: props.CloudFrontDomainName ? "true" : "false",
    },
  };
}

// ========================================================================
// UPDATE HANDLER
// ========================================================================

/**
 * Handle Update events
 *
 * Strategy:
 *  - If the domain name has NOT changed, reuse the existing certificate ARN.
 *    CloudFront distributions can take 5–15 minutes to update; deleting the
 *    old cert while CloudFront is mid-update causes a 400 "SSL certificate
 *    doesn't exist" error (UPDATE_FAILED on the distribution resource).
 *  - If the domain name HAS changed, request a new certificate and leave the
 *    old one intact. CloudFront must finish its update before the old cert can
 *    safely be deleted. Manual cleanup (or the Delete handler) handles removal.
 *
 * NOTE: We deliberately NEVER delete the old certificate inside handleUpdate.
 * The Delete handler is responsible for cert cleanup on stack teardown.
 */
async function handleUpdate(
  event: CloudFormationCustomResourceEvent,
  context: Context,
): Promise<CrProviderResponse> {
  const oldPhysicalId =
    "PhysicalResourceId" in event ? event.PhysicalResourceId : undefined;

  const newProps = event.ResourceProperties as unknown as AcmCertificateProperties;
  const oldProps = "OldResourceProperties" in event
    ? (event.OldResourceProperties as unknown as AcmCertificateProperties)
    : undefined;

  console.log("Certificate update requested");
  console.log(`Old physical resource ID: ${oldPhysicalId ?? "none"}`);

  // ── DNS-only / A-record modes ─────────────────────────────────────────────
  // These don't involve ACM certificates; delegate directly to handleCreate
  // (which is idempotent for alias / A-record resources).
  const skipCert = newProps.SkipCertificateCreation === "true";
  if (skipCert) {
    console.log("DNS-only / A-record mode: delegating to handleCreate");
    return handleCreate(event, context);
  }

  // ── Full certificate mode ─────────────────────────────────────────────
  const domainChanged =
    oldProps?.DomainName !== newProps.DomainName ||
    JSON.stringify(oldProps?.SubjectAlternativeNames ?? []) !==
      JSON.stringify(newProps.SubjectAlternativeNames ?? []);

  if (!domainChanged && oldPhysicalId?.startsWith("arn:aws:acm:")) {
    // Domain is unchanged — check whether the existing cert is still alive
    // before reusing it. A previous failed deploy may have deleted it, leaving
    // CloudFormation's stored physical ID pointing to a ghost ARN.
    const certIsValid = await isCertificateValid(oldPhysicalId);

    if (certIsValid) {
      // Cert exists and is ISSUED — safe to reuse. Returning the same ARN
      // means CloudFormation does not update the CloudFront distribution's
      // ViewerCertificate, avoiding the 5–15 min propagation window entirely.
      console.log(
        `Domain unchanged (${newProps.DomainName}) and cert is ISSUED. ` +
        `Reusing existing certificate: ${oldPhysicalId}`,
      );
      return {
        PhysicalResourceId: oldPhysicalId,
        Data: {
          CertificateArn: oldPhysicalId,
          DomainName: newProps.DomainName,
          ValidationStatus: "REUSED",
          HostedZoneId: newProps.HostedZoneId,
          Environment: newProps.Environment,
          CloudFrontAliasCreated: newProps.CloudFrontDomainName ? "true" : "false",
        },
      };
    }

    // Cert is gone (deleted by a previous failed deploy).
    // Before creating a brand-new certificate (which triggers another
    // 10-minute DNS validation wait), scan ACM for an already-ISSUED cert
    // that covers this domain. This reconciles CloudFormation state drift
    // where CFN's stored physicalResourceId points to a deleted cert but a
    // valid cert for the same domain still exists (e.g. cc20522d is live on
    // CloudFront while CFN thinks the cert is 2c56f8f7).
    console.warn(
      `Certificate ${oldPhysicalId} no longer exists in ACM (deleted by a ` +
      "previous failed deploy). Scanning ACM for an existing ISSUED cert before creating a new one.",
    );

    const existingCert = await findExistingIssuedCertificate(newProps.DomainName);
    if (existingCert) {
      console.log(
        `Found existing ISSUED certificate for ${newProps.DomainName}: ${existingCert}. ` +
        "Reusing it to reconcile CloudFormation state drift — no new cert needed.",
      );
      return {
        PhysicalResourceId: existingCert,
        Data: {
          CertificateArn: existingCert,
          DomainName: newProps.DomainName,
          ValidationStatus: "RECONCILED",
          HostedZoneId: newProps.HostedZoneId,
          Environment: newProps.Environment,
          CloudFrontAliasCreated: newProps.CloudFrontDomainName ? "true" : "false",
        },
      };
    }
  }

  // A new certificate is needed — either because the domain changed, or because
  // the existing cert was deleted by a previous failed deploy (recovery path).
  // IMPORTANT: Do NOT delete the old certificate here.
  // CloudFront distributions take 5–15 min to update; any surviving old cert
  // must remain valid for the entire duration. Deleting it immediately causes
  // CloudFront to return a 400 "SSL certificate doesn't exist" error, putting
  // the distribution into UPDATE_FAILED.
  //
  // Old certificates will be cleaned up by the Delete handler on stack teardown,
  // or can be removed manually from the ACM console once CloudFront confirms
  // the update is complete.
  const reason = domainChanged
    ? `domain changed from "${oldProps?.DomainName ?? "unknown"}" to "${newProps.DomainName}"`
    : `existing certificate ${oldPhysicalId} is no longer valid in ACM (recovery path)`;
  console.log(`Requesting new certificate: ${reason}.`);
  if (oldPhysicalId && !domainChanged) {
    console.log(
      "Old cert was deleted by a previous failed deploy — creating fresh cert for the same domain.",
    );
  }

  const createResponse = await handleCreate(event, context);
  return createResponse;
}

// ========================================================================
// DELETE HANDLER
// ========================================================================

/**
 * Handle Delete events
 */
async function handleDelete(
  event: CloudFormationCustomResourceEvent,
  _context: Context,
): Promise<CrProviderResponse> {
  const physicalResourceId =
    "PhysicalResourceId" in event
      ? event.PhysicalResourceId
      : "acm-certificate-cleanup";

  const props = event.ResourceProperties as unknown as AcmCertificateProperties;

  // Simple A record mode: Delete A record pointing to EIP
  if (physicalResourceId.startsWith('dns-a-record-') && props.RecordValue) {
    console.log(`Simple A record mode: Deleting A record for ${props.DomainName}`);

    try {
      const credentials = await assumeCrossAccountRole(props.CrossAccountRoleArn);
      await deleteSimpleARecord(
        props.HostedZoneId,
        props.DomainName,
        props.RecordValue,
        credentials,
      );
      console.log("Simple A record deleted");
    } catch (error: unknown) {
      const errName = (error as { name?: string })?.name ?? 'Unknown';
      const errMsg = (error as { message?: string })?.message ?? String(error);
      if (errName === 'AccessDeniedException' || errName === 'AccessDenied') {
        console.warn(`Cross-account role may have been deleted: ${errMsg}`);
      } else {
        console.warn(`A record deletion failed (${errName}): ${errMsg}`);
      }
      console.log("Continuing — A record may already be deleted");
    }

    return {
      PhysicalResourceId: physicalResourceId,
      Data: {},
    };
  }

  // DNS-only mode: Only delete CloudFront alias record, skip certificate deletion
  if (physicalResourceId.startsWith('dns-alias-') && props.CloudFrontDomainName) {
    console.log(`DNS-only mode: Deleting CloudFront alias for ${props.DomainName}`);
    
    try {
      const credentials = await assumeCrossAccountRole(props.CrossAccountRoleArn);
      await deleteCloudFrontAliasRecord(
        props.HostedZoneId,
        props.DomainName,
        props.CloudFrontDomainName,
        credentials,
      );
      console.log("CloudFront alias record deleted");
    } catch (error: unknown) {
      // Classify the failure to aid debugging during stack deletions.
      // If the cross-account role was deleted before this stack, STS will
      // return AccessDenied or the identity won't be found.
      const errName = (error as { name?: string })?.name ?? 'Unknown';
      const errMsg = (error as { message?: string })?.message ?? String(error);
      if (errName === 'AccessDeniedException' || errName === 'AccessDenied') {
        console.warn(`Cross-account role may have been deleted: ${errMsg}`);
      } else if (errName === 'NoSuchHostedZone' || errName === 'HostedZoneNotFound') {
        console.warn(`Hosted zone no longer exists: ${errMsg}`);
      } else {
        console.warn(`CloudFront alias deletion failed (${errName}): ${errMsg}`);
      }
      console.log("Continuing — alias record may already be deleted");
    }

    return {
      PhysicalResourceId: physicalResourceId,
      Data: {},
    };
  }

  // Full certificate mode
  const certificateArn = physicalResourceId;
  console.log("Deleting ACM certificate");
  console.log(`Certificate ARN: ${certificateArn}`);

  try {
    // STEP 1: Get DNS validation records before deleting certificate
    let validationRecords: DnsValidationRecord[] = [];
    try {
      validationRecords = await getDnsValidationRecords(certificateArn);
    } catch (_error) {
      console.log(
        "Could not retrieve validation records (certificate may already be deleted)",
      );
    }

    // STEP 2: Delete DNS validation records from Route 53
    if (
      validationRecords.length > 0 &&
      props.CrossAccountRoleArn &&
      props.HostedZoneId
    ) {
      try {
        const credentials = await assumeCrossAccountRole(
          props.CrossAccountRoleArn,
        );
        await deleteDnsValidationRecords(
          props.HostedZoneId,
          validationRecords,
          credentials,
        );
        console.log("DNS validation records deleted");

        // STEP 2.5: Delete CloudFront alias A record (if CloudFrontDomainName was provided)
        if (props.CloudFrontDomainName) {
          await deleteCloudFrontAliasRecord(
            props.HostedZoneId,
            props.DomainName,
            props.CloudFrontDomainName,
            credentials,
          );
          console.log("CloudFront alias record deleted");
        }
      } catch (error: unknown) {
        // Classify cross-account failure to prevent confusion during
        // stack teardowns where the cross-account role is deleted first.
        const errName = (error as { name?: string })?.name ?? 'Unknown';
        const errMsg = (error as { message?: string })?.message ?? String(error);
        if (errName === 'AccessDeniedException' || errName === 'AccessDenied') {
          console.warn(`Cross-account role may have been deleted: ${errMsg}`);
        } else if (errName === 'NoSuchHostedZone' || errName === 'HostedZoneNotFound') {
          console.warn(`Hosted zone no longer exists: ${errMsg}`);
        } else {
          console.error(`DNS record deletion failed (${errName}): ${errMsg}`);
        }
        console.log("Continuing with certificate deletion");
      }
    }

    // STEP 3: Delete ACM certificate
    await deleteCertificate(certificateArn);
    console.log("Certificate deleted successfully");
  } catch (error) {
    console.error("Error during deletion:", error);
    console.log("Certificate may already be deleted or doesn't exist");
  }

  // Return cr.Provider format
  return {
    PhysicalResourceId: certificateArn,
    Data: {},
  };
}

// ========================================================================
// VALIDATION
// ========================================================================

/**
 * Validate required properties
 */
function validateProperties(props: Partial<AcmCertificateProperties>): void {
  const missing: string[] = [];

  if (!props.DomainName) missing.push("DomainName");
  if (!props.HostedZoneId) missing.push("HostedZoneId");
  if (!props.CrossAccountRoleArn) missing.push("CrossAccountRoleArn");
  if (!props.Environment) missing.push("Environment");

  if (missing.length > 0) {
    throw new Error(
      `Missing required properties: ${missing.join(", ")}\n\n` +
      "Required properties:\n" +
      "  DomainName: Domain for certificate (e.g., 'monitoring.example.com')\n" +
      "  HostedZoneId: Route 53 hosted zone ID in root account\n" +
      "  CrossAccountRoleArn: IAM role ARN for Route 53 access\n" +
      "  Environment: Environment name for tagging",
    );
  }

  // Validate domain name format
  if (props.DomainName && !isValidDomainName(props.DomainName)) {
    throw new Error(
      `Invalid domain name: ${props.DomainName}\n\n` +
      "Domain name must be a valid DNS name (e.g., 'monitoring.example.com')",
    );
  }

  // Validate hosted zone ID format
  if (props.HostedZoneId && !props.HostedZoneId.match(/^Z[A-Z0-9]+$/)) {
    throw new Error(
      `Invalid hosted zone ID: ${props.HostedZoneId}\n\n` +
      "Hosted zone ID must start with 'Z' followed by alphanumeric characters",
    );
  }

  // Validate role ARN format
  if (
    props.CrossAccountRoleArn &&
    !props.CrossAccountRoleArn.match(/^arn:aws:iam::\d{12}:role\/[\w+=,.@-]+$/)
  ) {
    throw new Error(
      `Invalid IAM role ARN: ${props.CrossAccountRoleArn}\n\n` +
      "Role ARN must be in format: arn:aws:iam::ACCOUNT_ID:role/ROLE_NAME",
    );
  }
}

/**
 * Validate domain name format
 */
function isValidDomainName(domain: string): boolean {
  // Basic domain validation (simplified)
  const domainRegex = /^(\*\.)?([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$/i;
  return domainRegex.test(domain);
}

// ========================================================================
// ACM CERTIFICATE OPERATIONS
// ========================================================================

/**
 * Request ACM certificate with DNS validation
 */
async function requestCertificate(
  domainName: string,
  subjectAlternativeNames: string[] | undefined,
  environment: string,
): Promise<string> {
  const command = new RequestCertificateCommand({
    DomainName: domainName,
    SubjectAlternativeNames: subjectAlternativeNames,
    ValidationMethod: "DNS",
    Tags: [
      { Key: "Name", Value: `${environment}-${domainName}` },
      { Key: "Environment", Value: environment },
      { Key: "ManagedBy", Value: "CDK" },
      { Key: "DomainName", Value: domainName },
    ],
  });

  const response = await acmClient.send(command);

  if (!response.CertificateArn) {
    throw new Error("Certificate ARN not returned from ACM");
  }

  return response.CertificateArn;
}

/**
 * Delete ACM certificate
 */
async function deleteCertificate(certificateArn: string): Promise<void> {
  // Skip if not a valid ARN
  if (!certificateArn.startsWith("arn:aws:acm:")) {
    console.log("Not a valid certificate ARN, skipping deletion");
    return;
  }

  const command = new DeleteCertificateCommand({
    CertificateArn: certificateArn,
  });

  await acmClient.send(command);
}

/**
 * Check whether an ACM certificate exists and is in ISSUED state.
 *
 * Returns `true`  — cert exists and is ISSUED (safe to reuse for CloudFront).
 * Returns `false` — cert is missing, deleted, FAILED, or EXPIRED.
 *
 * Used by handleUpdate to detect certificates that were deleted by a previous
 * failed deploy before blindly reusing the stored physical resource ID.
 *
 * @param certificateArn - Full ACM certificate ARN to validate.
 * @returns Whether the certificate is valid and usable.
 */
async function isCertificateValid(certificateArn: string): Promise<boolean> {
  if (!certificateArn.startsWith("arn:aws:acm:")) {
    return false;
  }

  try {
    const command = new DescribeCertificateCommand({
      CertificateArn: certificateArn,
    });
    const response = await acmClient.send(command);
    const status = response.Certificate?.Status;

    const isValid = status === CertificateStatus.ISSUED;
    console.log(`Certificate ${certificateArn} status: ${status ?? "unknown"} → ${isValid ? "valid" : "invalid"}`);
    return isValid;
  } catch (error: unknown) {
    // ResourceNotFoundException → cert was deleted; any other error → treat as invalid.
    const errName = (error as { name?: string })?.name ?? "Unknown";
    console.warn(`isCertificateValid check failed (${errName}) for ${certificateArn} → treating as invalid`);
    return false;
  }
}

/**
 * Scan ACM for an already-ISSUED certificate covering the given domain.
 *
 * Used as a reconciliation step when CloudFormation's stored physical resource
 * ID points to a deleted certificate but a valid cert for the same domain still
 * exists in ACM (e.g. left over from a previous successful deploy). Returning
 * the existing ARN avoids a full 10-minute DNS re-validation cycle and prevents
 * an unnecessary CloudFront certificate swap.
 *
 * Pagination is handled automatically. Returns the first matching ISSUED cert,
 * or `undefined` if none is found.
 *
 * @param domainName - The primary domain to match (e.g. 'nelsonlamounier.com').
 * @returns The ARN of a matching ISSUED certificate, or `undefined`.
 */
async function findExistingIssuedCertificate(domainName: string): Promise<string | undefined> {
  console.log(`Scanning ACM for existing ISSUED certificate for domain: ${domainName}`);

  let nextToken: string | undefined;

  do {
    const command = new ListCertificatesCommand({
      CertificateStatuses: [CertificateStatus.ISSUED],
      NextToken: nextToken,
      MaxItems: 100,
    });

    const response = await acmClient.send(command);
    const matches = (response.CertificateSummaryList ?? []).filter(
      (cert) => cert.DomainName === domainName && cert.CertificateArn,
    );

    if (matches.length > 0 && matches[0].CertificateArn) {
      console.log(`Found ISSUED certificate ${matches[0].CertificateArn} for ${domainName}`);
      return matches[0].CertificateArn;
    }

    nextToken = response.NextToken;
  } while (nextToken);

  console.log(`No existing ISSUED certificate found for ${domainName}`);
  return undefined;
}


/**
 * DNS validation record structure
 */
interface DnsValidationRecord {
  name: string;
  type: string;
  value: string;
}

/**
 * Get DNS validation records from ACM certificate
 * Includes retry logic since records may not be immediately available after certificate creation
 */
async function getDnsValidationRecords(
  certificateArn: string,
  maxRetries: number = 6,  // 6 retries * 5 seconds = 30 seconds max wait
  retryDelayMs: number = 5000,
): Promise<DnsValidationRecord[]> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`Fetching DNS validation records (attempt ${attempt}/${maxRetries})`);
    
    const command = new DescribeCertificateCommand({
      CertificateArn: certificateArn,
    });

    const response = await acmClient.send(command);

    if (!response.Certificate?.DomainValidationOptions) {
      console.log("No domain validation options yet, retrying...");
      if (attempt < maxRetries) {
        await sleep(retryDelayMs);
        continue;
      }
      throw new Error("No domain validation options returned from ACM after max retries");
    }

    const records: DnsValidationRecord[] = [];

    for (const validation of response.Certificate.DomainValidationOptions) {
      if (validation.ResourceRecord) {
        records.push({
          name: validation.ResourceRecord.Name || "",
          type: validation.ResourceRecord.Type || "CNAME",
          value: validation.ResourceRecord.Value || "",
        });
      }
    }

    if (records.length > 0) {
      console.log(`Found ${records.length} DNS validation record(s)`);
      return records;
    }

    // Records not available yet, wait and retry
    console.log("DNS validation records not yet available, waiting...");
    if (attempt < maxRetries) {
      await sleep(retryDelayMs);
    }
  }

  throw new Error("No DNS validation records found in certificate after max retries");
}


/**
 * Wait for certificate validation to complete
 */
async function waitForCertificateValidation(
  certificateArn: string,
): Promise<void> {
  console.log("Waiting for certificate validation...");

  for (let attempt = 1; attempt <= MAX_VALIDATION_ATTEMPTS; attempt++) {
    console.log(
      `Validation check ${attempt}/${MAX_VALIDATION_ATTEMPTS} (${attempt * 30}s elapsed)`,
    );

    const command = new DescribeCertificateCommand({
      CertificateArn: certificateArn,
    });

    const response = await acmClient.send(command);
    const status = response.Certificate?.Status;

    console.log(`  Certificate status: ${status}`);

    if (status === CertificateStatus.ISSUED) {
      console.log("Certificate validation complete");
      return;
    }

    if (status === CertificateStatus.FAILED) {
      const failureReason = response.Certificate?.FailureReason || "Unknown";
      throw new Error(
        `Certificate validation failed: ${failureReason}\n\n` +
        "Common causes:\n" +
        "1. DNS validation records not created correctly\n" +
        "2. DNS propagation not complete\n" +
        "3. Domain ownership verification failed\n" +
        "4. Cross-account role permissions insufficient",
      );
    }

    if (attempt < MAX_VALIDATION_ATTEMPTS) {
      console.log(
        `  Waiting ${POLLING_INTERVAL_MS / 1000}s before next check...`,
      );
      await sleep(POLLING_INTERVAL_MS);
    }
  }

  throw new Error(
    `Certificate validation timed out after ${(MAX_VALIDATION_ATTEMPTS * POLLING_INTERVAL_MS) / 60000} minutes.\n\n` +
    "Troubleshooting steps:\n" +
    "1. Verify DNS validation records were created in Route 53\n" +
    "2. Check DNS propagation using 'dig' or online DNS tools\n" +
    "3. Verify cross-account role has Route 53 permissions\n" +
    "4. Check ACM certificate status in AWS console\n" +
    "5. Increase Lambda timeout if validation is still in progress",
  );
}

// ========================================================================
// CROSS-ACCOUNT IAM
// ========================================================================

/**
 * Assume cross-account IAM role
 */
async function assumeCrossAccountRole(
  roleArn: string,
): Promise<CrossAccountCredentials> {
  const command = new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: "acm-certificate-dns-validation",
    DurationSeconds: 3600, // 1 hour
  });

  const response = await stsClient.send(command);

  if (
    !response.Credentials?.AccessKeyId ||
    !response.Credentials?.SecretAccessKey ||
    !response.Credentials?.SessionToken
  ) {
    throw new Error(
      "Failed to assume cross-account role - no credentials returned",
    );
  }

  return {
    accessKeyId: response.Credentials.AccessKeyId,
    secretAccessKey: response.Credentials.SecretAccessKey,
    sessionToken: response.Credentials.SessionToken,
  };
}

// ========================================================================
// ROUTE 53 OPERATIONS
// ========================================================================

/**
 * Create DNS validation records in Route 53
 */
async function createDnsValidationRecords(
  hostedZoneId: string,
  validationRecords: DnsValidationRecord[],
  credentials: CrossAccountCredentials,
): Promise<void> {
  console.log(`Creating DNS validation records in hosted zone ${hostedZoneId}`);

  const route53Client = new Route53Client({
    region: REGION,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  });

  const changes = validationRecords.map((record) => ({
    Action: ChangeAction.UPSERT,
    ResourceRecordSet: {
      Name: record.name,
      Type: record.type as RRType,
      TTL: 300,
      ResourceRecords: [{ Value: record.value }],
    },
  }));

  const command = new ChangeResourceRecordSetsCommand({
    HostedZoneId: hostedZoneId,
    ChangeBatch: {
      Comment: "DNS validation records for ACM certificate",
      Changes: changes,
    },
  });

  await route53Client.send(command);

  for (const record of validationRecords) {
    console.log(
      `  Created: ${record.name} (${record.type}) -> ${record.value}`,
    );
  }
}

/**
 * Delete DNS validation records from Route 53
 */
async function deleteDnsValidationRecords(
  hostedZoneId: string,
  validationRecords: DnsValidationRecord[],
  credentials: CrossAccountCredentials,
): Promise<void> {
  console.log(
    `Deleting DNS validation records from hosted zone ${hostedZoneId}`,
  );

  const route53Client = new Route53Client({
    region: REGION,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  });

  const changes = validationRecords.map((record) => ({
    Action: ChangeAction.DELETE,
    ResourceRecordSet: {
      Name: record.name,
      Type: record.type as RRType,
      TTL: 300,
      ResourceRecords: [{ Value: record.value }],
    },
  }));

  const command = new ChangeResourceRecordSetsCommand({
    HostedZoneId: hostedZoneId,
    ChangeBatch: {
      Comment: "Deleting ACM certificate validation records",
      Changes: changes,
    },
  });

  try {
    await route53Client.send(command);

    for (const record of validationRecords) {
      console.log(`  Deleted: ${record.name} (${record.type})`);
    }
  } catch (_error) {
    // If records don't exist, that's fine
    console.log("DNS records may already be deleted");
  }
}

// ========================================================================
// CLOUDFRONT ALIAS RECORD
// ========================================================================

/**
 * CloudFront hosted zone ID (constant for all CloudFront distributions)
 */
const CLOUDFRONT_HOSTED_ZONE_ID = "Z2FDTNDATAQYW2";

/**
 * Create or update CloudFront alias A record in Route 53
 */
async function createCloudFrontAliasRecord(
  hostedZoneId: string,
  domainName: string,
  cloudFrontDomainName: string,
  credentials: CrossAccountCredentials,
): Promise<void> {
  console.log(`Creating CloudFront alias A record for ${domainName} -> ${cloudFrontDomainName}`);

  const route53Client = new Route53Client({
    region: "us-east-1", // Route 53 is global but uses us-east-1 endpoint
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  });

  const command = new ChangeResourceRecordSetsCommand({
    HostedZoneId: hostedZoneId,
    ChangeBatch: {
      Comment: `CloudFront alias for ${domainName}`,
      Changes: [
        {
          Action: ChangeAction.UPSERT,
          ResourceRecordSet: {
            Name: domainName,
            Type: "A",
            AliasTarget: {
              HostedZoneId: CLOUDFRONT_HOSTED_ZONE_ID,
              DNSName: cloudFrontDomainName,
              EvaluateTargetHealth: false,
            },
          },
        },
      ],
    },
  });

  await route53Client.send(command);
  console.log(`CloudFront alias A record created: ${domainName} -> ${cloudFrontDomainName}`);
}

/**
 * Delete CloudFront alias A record from Route 53
 */
async function deleteCloudFrontAliasRecord(
  hostedZoneId: string,
  domainName: string,
  cloudFrontDomainName: string,
  credentials: CrossAccountCredentials,
): Promise<void> {
  console.log(`Deleting CloudFront alias A record for ${domainName}`);

  const route53Client = new Route53Client({
    region: "us-east-1",
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  });

  const command = new ChangeResourceRecordSetsCommand({
    HostedZoneId: hostedZoneId,
    ChangeBatch: {
      Comment: `Deleting CloudFront alias for ${domainName}`,
      Changes: [
        {
          Action: ChangeAction.DELETE,
          ResourceRecordSet: {
            Name: domainName,
            Type: "A",
            AliasTarget: {
              HostedZoneId: CLOUDFRONT_HOSTED_ZONE_ID,
              DNSName: cloudFrontDomainName,
              EvaluateTargetHealth: false,
            },
          },
        },
      ],
    },
  });

  try {
    await route53Client.send(command);
    console.log(`CloudFront alias A record deleted: ${domainName}`);
  } catch (_error) {
    // If record doesn't exist, that's fine
    console.log(`CloudFront alias record may already be deleted: ${domainName}`);
  }
}

/**
 * Create or update a simple A record in Route 53 pointing to an IP address
 * Used for admin service DNS (e.g., ops.nelsonlamounier.com -> EIP)
 */
async function createSimpleARecord(
  hostedZoneId: string,
  domainName: string,
  ipAddress: string,
  credentials: CrossAccountCredentials,
): Promise<void> {
  console.log(`Creating simple A record for ${domainName} -> ${ipAddress}`);

  const route53Client = new Route53Client({
    region: "us-east-1",
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  });

  const command = new ChangeResourceRecordSetsCommand({
    HostedZoneId: hostedZoneId,
    ChangeBatch: {
      Comment: `A record for ${domainName} -> ${ipAddress}`,
      Changes: [
        {
          Action: ChangeAction.UPSERT,
          ResourceRecordSet: {
            Name: domainName,
            Type: "A",
            TTL: 300,
            ResourceRecords: [{ Value: ipAddress }],
          },
        },
      ],
    },
  });

  await route53Client.send(command);
  console.log(`Simple A record created: ${domainName} -> ${ipAddress}`);
}

/**
 * Delete a simple A record from Route 53
 */
async function deleteSimpleARecord(
  hostedZoneId: string,
  domainName: string,
  ipAddress: string,
  credentials: CrossAccountCredentials,
): Promise<void> {
  console.log(`Deleting simple A record for ${domainName}`);

  const route53Client = new Route53Client({
    region: "us-east-1",
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  });

  const command = new ChangeResourceRecordSetsCommand({
    HostedZoneId: hostedZoneId,
    ChangeBatch: {
      Comment: `Deleting A record for ${domainName}`,
      Changes: [
        {
          Action: ChangeAction.DELETE,
          ResourceRecordSet: {
            Name: domainName,
            Type: "A",
            TTL: 300,
            ResourceRecords: [{ Value: ipAddress }],
          },
        },
      ],
    },
  });

  try {
    await route53Client.send(command);
    console.log(`Simple A record deleted: ${domainName}`);
  } catch (_error) {
    console.log(`A record may already be deleted: ${domainName}`);
  }
}

// ========================================================================
// UTILITIES
// ========================================================================


/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
