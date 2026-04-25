import {
  CreateLaunchTemplateVersionCommand,
  EC2Client,
  ModifyLaunchTemplateCommand,
} from '@aws-sdk/client-ec2';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

export interface UpdateLaunchTemplateEvent {
  paramName: string;
  role: 'workers' | 'control-plane';
}

export interface UpdateLaunchTemplateResult {
  role: string;
  env: string;
  amiId: string;
}

export async function handler(
  event: UpdateLaunchTemplateEvent,
  ec2Client: EC2Client = new EC2Client({}),
  ssmClient: SSMClient = new SSMClient({}),
): Promise<UpdateLaunchTemplateResult> {
  const env = event.paramName.split('/')[2];
  if (!env) throw new Error(`Cannot extract env from paramName: ${event.paramName}`);

  const amiParam = await ssmClient.send(new GetParameterCommand({ Name: event.paramName }));
  const amiId = amiParam.Parameter?.Value;
  if (!amiId) throw new Error(`SSM parameter ${event.paramName} has no value`);

  const ltIds = await getLtIds(env, event.role, ssmClient);

  for (const ltId of ltIds) {
    const created = await ec2Client.send(new CreateLaunchTemplateVersionCommand({
      LaunchTemplateId: ltId,
      SourceVersion: '$Latest',
      LaunchTemplateData: { ImageId: amiId },
    }));
    const versionNumber = created.LaunchTemplateVersion?.VersionNumber;
    if (versionNumber == null) throw new Error(`CreateLaunchTemplateVersion returned no VersionNumber for ${ltId}`);
    const newVersion = String(versionNumber);
    await ec2Client.send(new ModifyLaunchTemplateCommand({
      LaunchTemplateId: ltId,
      DefaultVersion: newVersion,
    }));
  }

  return { role: event.role, env, amiId };
}

async function getLtIds(env: string, role: string, ssmClient: SSMClient): Promise<string[]> {
  if (role === 'workers') {
    const p = await ssmClient.send(
      new GetParameterCommand({ Name: `/k8s/${env}/ami-refresh/workers/lt-ids` }),
    );
    const val = p.Parameter?.Value;
    if (!val) throw new Error(`SSM parameter /k8s/${env}/ami-refresh/workers/lt-ids has no value`);
    return JSON.parse(val);
  }
  const p = await ssmClient.send(
    new GetParameterCommand({ Name: `/k8s/${env}/ami-refresh/control-plane/lt-id` }),
  );
  const val = p.Parameter?.Value;
  if (!val) throw new Error(`SSM parameter /k8s/${env}/ami-refresh/control-plane/lt-id has no value`);
  return [val];
}
